import {
  INT_WIDTH,
  bigintToDisplay,
  checksum,
  decodeInt,
  decodeString,
  hexPreview,
  rangeInBounds,
  stringPreview,
  trimNulString,
} from './bytes';
import type {
  AppState,
  ByteRange,
  Hypothesis,
  HypothesisConfig,
  IntKind,
  OffsetBase,
  RegionSpec,
  SampleRecord,
  SampleStatus,
  SampleVerification,
  Verification,
} from './types';

export interface SampleBlob {
  sample: SampleRecord;
  bytes: Uint8Array;
}

export interface FieldEvaluation {
  range: ByteRange;
  value: bigint;
  bytes: Uint8Array;
}

export interface RegionResolution {
  range: ByteRange;
  /** Human readable derivation, e.g. "length@4 * 1 = 3 from 8". */
  derivation: string;
  /** All contiguous pieces, in declared order (checksum coverage). */
  ranges?: ByteRange[];
}

export interface SampleContext {
  sample: SampleBlob;
  fields: Map<string, FieldEvaluation>;
  regions: Map<string, RegionResolution>;
}

const MAX_SANE_BIGINT = 1n << 40n;

function makeId(prefix: string, sequence: number): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${sequence.toString(36)}_${rand}`;
}

function idFactory(state: AppState) {
  return (prefix: string) => {
    state.sequence += 1;
    return makeId(prefix, state.sequence);
  };
}

export type VerifyKind = 'all' | 'hypothesis';

/** Multiply a decoded field value by a byte unit with overflow protection. */
export function scaleValue(value: bigint, unit: number): bigint {
  const scaled = value * BigInt(unit);
  if (scaled < 0n) throw new RangeError('scaled offset is negative');
  if (scaled > MAX_SANE_BIGINT) {
    throw new RangeError(`scaled value ${scaled.toString()} overflows safe bounds`);
  }
  return scaled;
}

function toOffset(value: bigint, documentLength: number): number {
  if (value < 0n) throw new RangeError('offset is negative');
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('offset exceeds safe integer range');
  }
  if (value > BigInt(documentLength)) {
    throw new RangeError(
      `offset ${value.toString()} beyond document length ${documentLength}`,
    );
  }
  return Number(value);
}

function baseFor(
  base: OffsetBase,
  anchor: FieldEvaluation | undefined,
  documentLength: number,
): { offset: number; label: string } {
  switch (base) {
    case 'absolute':
    case 'document-start':
      return { offset: 0, label: '0' };
    case 'document-end':
      return { offset: documentLength, label: `end(${documentLength})` };
    case 'field-start':
      if (!anchor) throw new RangeError('anchor field unavailable');
      return { offset: anchor.range.start, label: `field-start(${anchor.range.start})` };
    case 'field-end':
      if (!anchor) throw new RangeError('anchor field unavailable');
      return { offset: anchor.range.end, label: `field-end(${anchor.range.end})` };
    default:
      throw new RangeError(`unsupported base ${base as string}`);
  }
}

/**
 * Resolve a scalar field (an integer-typed hypothesis) inside one sample.
 * Strings and regions never act as anchors.
 */
function evaluateField(
  hyp: Hypothesis,
  bytes: Uint8Array,
): FieldEvaluation {
  const { range, config } = hyp;
  if (!rangeInBounds(range.start, range.end, bytes.length)) {
    throw new RangeError(
      `field ${hyp.name} range [${range.start},${range.end}) out of bounds for ${bytes.length} bytes`,
    );
  }
  switch (config.type) {
    case 'integer':
    case 'enum':
    case 'offset':
    case 'length':
    case 'offsetTable':
    case 'checksum': {
      const width =
        config.type === 'offsetTable'
          ? INT_WIDTH[config.entryKind]
          : config.type === 'checksum'
            ? checksumWidth(config.algorithm)
            : INT_WIDTH[config.intKind];
      if (range.end - range.start < width) {
        throw new RangeError(`field ${hyp.name} too narrow for its declared integer width`);
      }
      const endian =
        config.type === 'offsetTable'
          ? config.endian
          : config.type === 'checksum'
            ? checksumEndian(config.algorithm)
            : config.endian;
      const kind: IntKind =
        config.type === 'offsetTable'
          ? config.entryKind
          : config.type === 'checksum'
            ? checksumIntKind(config.algorithm)
            : config.intKind;
      const value = decodeInt(bytes, range.start, kind, endian);
      return { range, value, bytes: bytes.subarray(range.start, range.start + width) };
    }
    case 'string':
      return { range, value: 0n, bytes: bytes.subarray(range.start, range.end) };
  }
}

function checksumWidth(algorithm: string): number {
  return algorithm.startsWith('xor8') || algorithm.startsWith('sum8')
    ? 1
    : algorithm.startsWith('sum16')
      ? 2
      : 4;
}

function checksumEndian(algorithm: string): 'little' | 'big' {
  return algorithm.endsWith('-le') ? 'little' : 'big';
}

function checksumIntKind(algorithm: string): IntKind {
  if (algorithm.includes('8')) return 'u8';
  if (algorithm.includes('16')) return 'u16';
  return 'u32';
}

export function resolveRegion(
  spec: RegionSpec,
  bytesLength: number,
  fields: Map<string, FieldEvaluation>,
): RegionResolution {
  switch (spec.kind) {
    case 'fixed': {
      // end === -1 is the canonical marker for "rest of document".
      const end = spec.end === -1 ? bytesLength : spec.end;
      if (!rangeInBounds(spec.start, end, bytesLength)) {
        throw new RangeError(
          `fixed region [${spec.start},${spec.end}) out of bounds for ${bytesLength} bytes`,
        );
      }
      return {
        range: { start: spec.start, end },
        derivation: spec.end === -1
          ? `fixed [${spec.start}, end)`
          : `fixed [${spec.start},${spec.end})`,
      };
    }
    case 'prefixTo': {
      const endField = fields.get(spec.endField);
      if (!endField) throw new RangeError('end field unavailable for prefixTo region');
      if (endField.range.start > bytesLength) {
        throw new RangeError('prefixTo end beyond document');
      }
      return {
        range: { start: 0, end: endField.range.start },
        derivation: `0 .. field@${endField.range.start}`,
      };
    }
    case 'between': {
      const startField = fields.get(spec.startField);
      const endField = fields.get(spec.endField);
      if (!startField || !endField) {
        throw new RangeError('boundary field unavailable for between region');
      }
      if (!rangeInBounds(startField.range.end, endField.range.start, bytesLength)) {
        throw new RangeError(
          `between region [${startField.range.end},${endField.range.start}) invalid`,
        );
      }
      return {
        range: { start: startField.range.end, end: endField.range.start },
        derivation: `field-end@${startField.range.end} .. field-start@${endField.range.start}`,
      };
    }
    case 'sized': {
      const lengthField = fields.get(spec.lengthField);
      if (!lengthField) throw new RangeError('length field unavailable for sized region');
      const start = spec.startField
        ? fields.get(spec.startField)?.range.end
        : spec.startConst;
      if (start === undefined) throw new RangeError('start field unavailable for sized region');
      const size = scaleValue(lengthField.value, 1);
      const endBig = BigInt(start) + size;
      const end = toOffset(endBig, bytesLength);
      if (end < start) throw new RangeError('sized region ends before its start');
      return {
        range: { start, end },
        derivation: `start ${start} + length ${size.toString()} = ${end}`,
      };
    }
  }
}

function resolveOffsetTarget(
  value: bigint,
  unit: number,
  base: OffsetBase,
  anchor: FieldEvaluation | undefined,
  documentLength: number,
): { target: number; derivation: string } {
  const scaled = scaleValue(value, unit);
  const { offset, label } = baseFor(base, anchor, documentLength);
  const target = toOffset(BigInt(offset) + scaled, documentLength);
  return { target, derivation: `${label} + ${value.toString()}*${unit} = ${target}` };
}

function fieldById(
  id: string | null,
  ctx: SampleContext,
): FieldEvaluation | undefined {
  if (!id) return undefined;
  return ctx.fields.get(id);
}

function observedFor(hyp: Hypothesis, ctx: SampleContext): string {
  const ev = ctx.fields.get(hyp.id);
  if (!ev) return 'unreadable';
  if (hyp.config.type === 'string') {
    const text = hyp.config.trimNul
      ? trimNulString(decodeString(ctx.sample.bytes, hyp.range.start, hyp.range.end, hyp.config.encoding))
      : decodeString(ctx.sample.bytes, hyp.range.start, hyp.range.end, hyp.config.encoding);
    return `"${stringPreview(text)}"`;
  }
  return bigintToDisplay(ev.value);
}

export function buildSampleContext(state: AppState, sample: SampleBlob): SampleContext {
  const ctx: SampleContext = {
    sample,
    fields: new Map(),
    regions: new Map(),
  };
  for (const hyp of Object.values(state.hypotheses)) {
    try {
      ctx.fields.set(hyp.id, evaluateField(hyp, sample.bytes));
    } catch {
      // A field that fails to decode is simply absent; hypotheses referencing
      // it report "inconclusive" for this sample.
    }
  }
  for (const hyp of Object.values(state.hypotheses)) {
    const cfg = hyp.config;
    if (cfg.type === 'length') {
      try {
        ctx.regions.set(hyp.id, resolveRegion(cfg.region, sample.bytes.length, ctx.fields));
      } catch {
        /* absent region */
      }
    } else if (cfg.type === 'checksum') {
      try {
        const ranges = cfg.covered.map((region) =>
          resolveRegion(region, sample.bytes.length, ctx.fields),
        );
        const all = ranges.flatMap((r) => r.ranges ?? [r.range]);
        ctx.regions.set(hyp.id, {
          range: {
            start: Math.min(...all.map((r) => r.start)),
            end: Math.max(...all.map((r) => r.end)),
          },
          derivation: ranges.map((r) => r.derivation).join('; '),
          ranges: all,
        });
      } catch {
        /* absent region */
      }
    }
  }
  return ctx;
}

function counterexample(
  sampleId: string,
  detail: string,
  observed: string,
  expected: string | undefined,
  jumpOffset: number,
): SampleVerification {
  return {
    sampleId,
    status: 'counterexample',
    detail,
    observed,
    expected,
    jumpOffset,
  };
}

function decodeStringStrict(
  bytes: Uint8Array,
  range: ByteRange,
  config: HypothesisConfig & { type: 'string' },
): string {
  const slice = bytes.subarray(range.start, range.end);
  const raw = decodeString(bytes, range.start, range.end, config.encoding);
  if (config.encoding === 'ascii' && slice.some((b) => b >= 0x80)) {
    throw new RangeError('non-ASCII byte in ascii string');
  }
  if (config.encoding === 'utf8') {
    new TextDecoder('utf-8', { fatal: true }).decode(slice);
  }
  if (config.encoding.startsWith('utf16') && slice.length % 2 !== 0) {
    throw new RangeError('odd length for UTF-16 string');
  }
  return config.trimNul ? trimNulString(raw) : raw;
}

function verifyInSample(hyp: Hypothesis, ctx: SampleContext): SampleVerification {
  const { sample, fields, regions } = ctx;
  const bytes = sample.bytes;
  const sampleId = sample.sample.id;
  const observed = observedFor(hyp, ctx);

  if (!rangeInBounds(hyp.range.start, hyp.range.end, bytes.length)) {
    return counterexample(
      sampleId,
      `区间 [${hyp.range.start},${hyp.range.end}) 超出样本长度 ${bytes.length}`,
      hexPreview(bytes, Math.min(hyp.range.start, bytes.length), bytes.length),
      `[${hyp.range.start},${hyp.range.end}) in 0..${bytes.length}`,
      Math.min(hyp.range.start, Math.max(0, bytes.length - 1)),
    );
  }

  const field = fields.get(hyp.id);
  if (!field) {
    return {
      sampleId,
      status: 'inconclusive',
      detail: '字段无法按声明宽度解码',
      observed,
    };
  }
  const cfg = hyp.config;

  if (cfg.type === 'integer') {
    return {
      sampleId,
      status: 'hit',
      detail: `按 ${cfg.intKind}/${cfg.endian} 解码成功`,
      observed,
    };
  }

  if (cfg.type === 'string') {
    try {
      decodeStringStrict(bytes, hyp.range, cfg);
      return {
        sampleId,
        status: 'hit',
        detail: `按 ${cfg.encoding} 解码为合法字符串`,
        observed,
      };
    } catch (error) {
      return counterexample(
        sampleId,
        `字符串解码失败: ${(error as Error).message}`,
        observed,
        'valid ' + cfg.encoding,
        hyp.range.start,
      );
    }
  }

  if (cfg.type === 'enum') {
    const label = cfg.mapping[field.value.toString()];
    if (label === undefined) {
      return counterexample(
        sampleId,
        `枚举值 ${field.value.toString()} 不在映射表中`,
        observed,
        Object.keys(cfg.mapping).join(' | '),
        hyp.range.start,
      );
    }
    return {
      sampleId,
      status: 'hit',
      detail: `枚举命中: ${label}`,
      observed: `${field.value.toString()} → ${label}`,
    };
  }

  if (cfg.type === 'offset') {
    const anchor = fieldById(cfg.anchorField, ctx);
    if (cfg.base.startsWith('field') && !anchor) {
      return {
        sampleId,
        status: 'inconclusive',
        detail: '锚点字段在本样本中不可用',
        observed,
      };
    }
    try {
      const { target, derivation } = resolveOffsetTarget(
        field.value,
        cfg.unit,
        cfg.base,
        anchor,
        bytes.length,
      );
      return {
        sampleId,
        status: 'hit',
        detail: `偏移解析到字节 ${target}（文档内）: ${derivation}`,
        observed,
        expected: `target=${target}`,
      };
    } catch (error) {
      return counterexample(
        sampleId,
        `偏移溢出或越界: ${(error as Error).message}`,
        observed,
        'target inside 0..' + bytes.length,
        hyp.range.start,
      );
    }
  }

  if (cfg.type === 'length') {
    const region = regions.get(hyp.id);
    if (!region) {
      return {
        sampleId,
        status: 'inconclusive',
        detail: '关联区域无法解析（依赖字段缺失或溢出）',
        observed,
      };
    }
    const actual = region.range.end - region.range.start;
    const declared = scaleValue(field.value, cfg.unit);
    if (declared === BigInt(actual)) {
      return {
        sampleId,
        status: 'hit',
        detail: `字段值 ${declared.toString()} 等于区域长度 ${actual}（${region.derivation}）`,
        observed,
        expected: `${actual}`,
      };
    }
    return counterexample(
      sampleId,
      `声明长度 ${declared.toString()} 与区域长度 ${actual} 不符（${region.derivation}）`,
      observed,
      `${actual}`,
      region.range.start,
    );
  }

  if (cfg.type === 'offsetTable') {
    const width = INT_WIDTH[cfg.entryKind];
    const total = hyp.range.end - hyp.range.start;
    let count = 0;
    if (typeof cfg.count === 'number') {
      count = cfg.count;
    } else {
      const countField = fields.get(cfg.count.field);
      if (!countField) {
        return {
          sampleId,
          status: 'inconclusive',
          detail: '表项计数字段不可用',
          observed,
        };
      }
      count = Number(countField.value);
    }
    if (total < count * width) {
      return counterexample(
        sampleId,
        `偏移表需要 ${count}×${width}=${count * width} 字节，区间只有 ${total}`,
        observed,
        `${count * width} bytes`,
        hyp.range.start,
      );
    }
    const anchor = fieldById(cfg.anchorField, ctx);
    const failures: string[] = [];
    for (let i = 0; i < count; i++) {
      const entryOffset = hyp.range.start + i * width;
      const value = decodeInt(bytes, entryOffset, cfg.entryKind, cfg.endian);
      try {
        const { target } = resolveOffsetTarget(
          value,
          cfg.unit,
          cfg.base,
          anchor,
          bytes.length,
        );
        if (target >= bytes.length) throw new RangeError(`entry ${i} targets end-of-buffer`);
      } catch (error) {
        failures.push(`#${i}=${value.toString()}(${entryOffset}): ${(error as Error).message}`);
      }
    }
    if (failures.length > 0) {
      return counterexample(
        sampleId,
        `偏移表存在越界表项: ${failures.slice(0, 3).join('; ')}`,
        observed,
        'all entries in bounds',
        hyp.range.start,
      );
    }
    return {
      sampleId,
      status: 'hit',
      detail: `${count} 个表项全部解析到文档内`,
      observed,
    };
  }

  if (cfg.type === 'checksum') {
    const region = regions.get(hyp.id);
    if (!region || !region.ranges) {
      return {
        sampleId,
        status: 'inconclusive',
        detail: '校验覆盖区域无法解析',
        observed,
      };
    }
    const covered = concatRanges(bytes, region.ranges);
    const expected = checksum(covered, cfg.algorithm);
    if (expected === field.value) {
      return {
        sampleId,
        status: 'hit',
        detail: `${cfg.algorithm} 校验通过（覆盖 ${covered.length} 字节）`,
        observed,
        expected: bigintToDisplay(expected),
      };
    }
    return counterexample(
      sampleId,
      `校验值不匹配：字段 ${field.value.toString()} ≠ 覆盖区计算值 ${expected.toString()}`,
      observed,
      bigintToDisplay(expected),
      hyp.range.start,
    );
  }

  return {
    sampleId,
    status: 'inconclusive',
    detail: '未知假设类型',
    observed,
  };
}

function concatRanges(bytes: Uint8Array, ranges: ByteRange[]): Uint8Array {
  const total = ranges.reduce((acc, range) => acc + (range.end - range.start), 0);
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const range of ranges) {
    out.set(bytes.subarray(range.start, range.end), cursor);
    cursor += range.end - range.start;
  }
  return out;
}

export function verifyHypotheses(
  state: AppState,
  blobs: Map<string, SampleBlob>,
  options: { hypothesisId?: string } = {},
): Verification[] {
  const samples = state.sampleOrder
    .map((id) => blobs.get(id))
    .filter((blob): blob is SampleBlob => Boolean(blob));
  const targets = options.hypothesisId
    ? Object.values(state.hypotheses).filter((hyp) => hyp.id === options.hypothesisId)
    : Object.values(state.hypotheses);

  return targets.map((hyp) => {
    const results = samples.map((sample) => {
      const ctx = buildSampleContext(state, sample);
      return verifyInSample(hyp, ctx);
    });
    const ids = (predicate: (result: SampleVerification) => boolean) =>
      results.filter(predicate).map((result) => result.sampleId);
    return {
      id: `${hyp.id}:v${state.sequence + 1}_${Math.random().toString(36).slice(2, 8)}`,
      hypothesisId: hyp.id,
      createdAt: new Date().toISOString(),
      sampleIds: samples.map((sample) => sample.sample.id),
      results,
      hitSampleIds: ids((result) => result.status === 'hit'),
      counterexampleSampleIds: ids((result) => result.status === 'counterexample'),
      inconclusiveSampleIds: ids((result) => result.status === 'inconclusive'),
    };
  });
}

export function latestVerification(
  state: AppState,
  hypothesisId: string,
): Verification | undefined {
  for (let i = state.verifications.length - 1; i >= 0; i--) {
    const verification = state.verifications[i];
    if (verification.hypothesisId === hypothesisId) return verification;
  }
  return undefined;
}

export function hypothesisStatus(
  state: AppState,
  hypothesisId: string,
): 'unverified' | SampleStatus | 'mixed' {
  const verification = latestVerification(state, hypothesisId);
  if (!verification) return 'unverified';
  if (verification.counterexampleSampleIds.length > 0) return 'counterexample';
  if (verification.hitSampleIds.length === verification.sampleIds.length) return 'hit';
  if (verification.hitSampleIds.length > 0) return 'mixed';
  return 'inconclusive';
}

export { idFactory };
