import { checksum, decodeInt, overlaps } from './bytes';
import { buildSampleContext, scaleValue, type SampleBlob } from './semantics';
import type {
  AppState,
  Candidate,
  ChecksumAlgorithm,
  Endianness,
  Hypothesis,
  HypothesisConfig,
  IntKind,
  OffsetBase,
  RegionSpec,
} from './types';

const CHECKSUM_ALGORITHMS: ChecksumAlgorithm[] = [
  'xor8',
  'sum8',
  'sum16-le',
  'sum16-be',
  'crc32-le',
  'crc32-be',
];

const UNSIGNED: Record<number, IntKind> = { 1: 'u8', 2: 'u16', 4: 'u32', 8: 'u64' };
const ENDIANS: Endianness[] = ['little', 'big'];
const UNITS = [1, 2, 4] as const;

interface Support {
  support: string[];
  opposing: string[];
}

function evaluate(
  state: AppState,
  blobs: Map<string, SampleBlob>,
  predicate: (ctx: ReturnType<typeof buildSampleContext>, bytes: Uint8Array) => boolean | null,
): Support {
  const support: string[] = [];
  const opposing: string[] = [];
  for (const sampleId of state.sampleOrder) {
    const sample = blobs.get(sampleId);
    if (!sample) continue;
    const outcome = predicate(buildSampleContext(state, sample), sample.bytes);
    if (outcome === true) support.push(sampleId);
    else if (outcome === false) opposing.push(sampleId);
  }
  return { support, opposing };
}

function scalarHypotheses(state: AppState): Hypothesis[] {
  const scalar = new Set(['integer', 'enum', 'offset', 'length']);
  return Object.values(state.hypotheses).filter(
    (hyp) => !hyp.retired && scalar.has(hyp.config.type),
  );
}

function readValue(
  ctx: ReturnType<typeof buildSampleContext>,
  field: Hypothesis,
  endian: Endianness,
): bigint | null {
  const width = field.range.end - field.range.start;
  const kind = UNSIGNED[width];
  if (!kind) return null;
  return decodeInt(ctx.sample.bytes, field.range.start, kind, endian);
}

function checksumWidth(algorithm: ChecksumAlgorithm): number {
  return algorithm.includes('16') ? 2 : algorithm.includes('crc') ? 4 : 1;
}

function coveredRegions(state: AppState, field: Hypothesis) {
  const result: Array<{ region: RegionSpec; label: string }> = [
    { region: { kind: 'prefixTo', endField: field.id }, label: `“${field.name}”之前的全部字节` },
  ];
  for (const other of Object.values(state.hypotheses)) {
    if (other.id === field.id || other.retired) continue;
    if (!overlaps(other.range, field.range)) {
      result.push({
        region: { kind: 'between', startField: other.id, endField: field.id },
        label: `从“${other.name}”之后到“${field.name}”`,
      });
    }
  }
  return result;
}

function resolveRegionBytes(
  ctx: ReturnType<typeof buildSampleContext>,
  region: RegionSpec,
  bytes: Uint8Array,
): Array<ByteRangeLike> {
  switch (region.kind) {
    case 'fixed':
      return [{ start: region.start, end: region.end === -1 ? bytes.length : region.end }];
    case 'prefixTo': {
      const end = ctx.fields.get(region.endField)?.range.start;
      if (end === undefined) throw new Error('missing end field');
      return [{ start: 0, end }];
    }
    case 'between': {
      const start = ctx.fields.get(region.startField)?.range.end;
      const end = ctx.fields.get(region.endField)?.range.start;
      if (start === undefined || end === undefined || start > end) throw new Error('bad region');
      return [{ start, end }];
    }
    case 'sized': {
      const lengthField = ctx.fields.get(region.lengthField);
      if (!lengthField) throw new Error('missing length field');
      const start = region.startField ? ctx.fields.get(region.startField)?.range.end : region.startConst;
      if (start === undefined) throw new Error('missing start field');
      const end = Number(BigInt(start) + lengthField.value);
      if (end > bytes.length) throw new Error('sized region OOB');
      return [{ start, end }];
    }
  }
}

type ByteRangeLike = { start: number; end: number };

function concatCovered(bytes: Uint8Array, ranges: ByteRangeLike[]): Uint8Array {
  const total = ranges.reduce((acc, range) => acc + range.end - range.start, 0);
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const range of ranges) {
    out.set(bytes.subarray(range.start, range.end), cursor);
    cursor += range.end - range.start;
  }
  return out;
}

/**
 * Discover cross-sample correlations. Every candidate records its supporting
 * and opposing samples; nothing enters a draft without explicit confirmation.
 */
export function discoverCandidates(
  state: AppState,
  blobList: SampleBlob[],
): Array<Omit<Candidate, 'id' | 'createdAt' | 'status'>> {
  const blobs = new Map(blobList.map((blob) => [blob.sample.id, blob]));
  const found: Array<Omit<Candidate, 'id' | 'createdAt' | 'status'>> = [];
  const scalars = scalarHypotheses(state);
  const all = Object.values(state.hypotheses).filter((hyp) => !hyp.retired);

  const consider = (
    kind: Candidate['kind'],
    field: Hypothesis,
    summary: string,
    spec: HypothesisConfig,
    result: Support,
  ) => {
    if (result.support.length >= 2 && result.opposing.length === 0) {
      found.push({
        kind,
        fieldRange: { ...field.range },
        summary,
        spec,
        supportSampleIds: result.support,
        opposingSampleIds: result.opposing,
      });
    }
  };

  // Length: field * unit == distance between two points.
  for (const field of scalars) {
    const width = field.range.end - field.range.start;
    const intKind = UNSIGNED[width];
    if (!intKind) continue;
    const starts: Array<{ kind: 'const' | 'field-end'; fieldId: string | null; offset: bigint; label: string }> = [
      { kind: 'const', fieldId: null, offset: 0n, label: '文档开头' },
      { kind: 'field-end', fieldId: field.id, offset: BigInt(field.range.end), label: '“' + field.name + '”之后' },
    ];
    for (const other of all.filter((other) => other.id !== field.id)) {
      starts.push({ kind: 'field-end' as const, fieldId: other.id, offset: BigInt(other.range.end), label: `“${other.name}”之后` });
    }
    const ends = [
      { kind: 'doc-end' as const, fieldId: null as string | null, offset: null as bigint | null, label: '文档末尾' },
      ...all.filter((other) => other.id !== field.id).flatMap((other) => [
        { kind: 'field-start' as const, fieldId: other.id, offset: BigInt(other.range.start), label: `“${other.name}”开头` },
        { kind: 'field-end' as const, fieldId: other.id, offset: BigInt(other.range.end), label: `“${other.name}”之后` },
      ]),
    ];

    for (const endian of ENDIANS) {
      for (const unit of UNITS) {
        for (const start of starts) {
          for (const end of ends) {
            const result = evaluate(state, blobs, (ctx, bytes) => {
              const value = readValue(ctx, field, endian);
              if (value === null) return null;
              let length: bigint;
              try {
                length = scaleValue(value, unit);
              } catch {
                return false;
              }
              const startOffset = start.kind === 'const'
                ? start.offset
                : (ctx.fields.get(start.fieldId!)?.range.end !== undefined ? BigInt(ctx.fields.get(start.fieldId!)!.range.end) : null);
              if (startOffset === null) return null;
              const endOffset = end.kind === 'doc-end'
                ? BigInt(bytes.length)
                : (end.kind === 'field-end' || end.kind === 'field-start')
                  ? (end.fieldId ? BigInt(ctx.fields.get(end.fieldId)!.range[end.kind === 'field-end' ? 'end' : 'start']) : null)
                  : null;
              if (endOffset === null) return null;
              return length === endOffset - startOffset;
            });
            if (result.support.length < 2 || result.opposing.length > 0) continue;
            const region = makeRegion(start, end);
            if (!region) continue;
            consider(
              'length',
              field,
              `“${field.name}”(${endian === 'little' ? '小端' : '大端'}) ×${unit} 等于从${start.label}到${end.label}的长度`,
              { type: 'length', intKind, endian, unit, region },
              result,
            );
          }
        }
      }
    }
  }

  // Offset: base + field * unit == start of another field.
  for (const field of scalars) {
    const width = field.range.end - field.range.start;
    const intKind = UNSIGNED[width];
    if (!intKind) continue;
    const bases: Array<{ base: OffsetBase; anchor: Hypothesis | null; label: string }> = [
      { base: 'document-start', anchor: null, label: '文档开头' },
      { base: 'document-end', anchor: null, label: '文档末尾' },
      ...all.filter((other) => other.id !== field.id).flatMap((other) => [
        { base: 'field-start' as OffsetBase, anchor: other, label: `“${other.name}”开头` },
        { base: 'field-end' as OffsetBase, anchor: other, label: `“${other.name}”之后` },
      ]),
    ];
    for (const endian of ENDIANS) {
      for (const unit of UNITS) {
        for (const { base, anchor, label } of bases) {
          for (const target of all.filter((target) => target.id !== field.id)) {
            const result = evaluate(state, blobs, (ctx, bytes) => {
              const value = readValue(ctx, field, endian);
              if (value === null) return null;
              let scaled: bigint;
              try {
                scaled = scaleValue(value, unit);
              } catch {
                return false;
              }
              let baseOffset: bigint;
              if (base === 'document-start') baseOffset = 0n;
              else if (base === 'document-end') baseOffset = BigInt(bytes.length);
              else {
                const anchorEv = anchor ? ctx.fields.get(anchor.id) : undefined;
                if (!anchorEv) return null;
                baseOffset = BigInt(base === 'field-start' ? anchorEv.range.start : anchorEv.range.end);
              }
              return baseOffset + scaled === BigInt(target.range.start);
            });
            if (result.support.length < 2 || result.opposing.length > 0) continue;
            consider(
              'offset',
              field,
              `“${field.name}”(${endian === 'little' ? '小端' : '大端'}) ×${unit} 从${label}解析到“${target.name}”开头`,
              { type: 'offset', intKind, endian, base, unit, anchorField: anchor?.id ?? null },
              result,
            );
          }
        }
      }
    }
  }

  // Checksum: field equals simple digest of a non-overlapping region.
  for (const field of scalars) {
    const width = field.range.end - field.range.start;
    if (![1, 2, 4].includes(width)) continue;
    for (const { region, label } of coveredRegions(state, field)) {
      for (const algorithm of CHECKSUM_ALGORITHMS) {
        if (checksumWidth(algorithm) !== width) continue;
        const result = evaluate(state, blobs, (ctx, bytes) => {
          const ev = ctx.fields.get(field.id);
          if (!ev) return null;
          try {
            const ranges = resolveRegionBytes(ctx, region, bytes);
            if (ranges.some((range) => overlaps(range, field.range))) return null;
            return ev.value === checksum(concatCovered(bytes, ranges), algorithm);
          } catch {
            return null;
          }
        });
        if (result.support.length < 2 || result.opposing.length > 0) continue;
        consider(
          'checksum',
          field,
          `“${field.name}” 等于 ${label}的 ${algorithm}`,
          { type: 'checksum', algorithm, covered: [region] },
          result,
        );
      }
    }
  }

  return deduplicate(found);
}

function makeRegion(
  start: { kind: string; fieldId: string | null; offset: bigint },
  end: { kind: string; fieldId: string | null; offset: bigint | null },
): RegionSpec | null {
  if (end.kind === 'doc-end') {
    if (start.kind === 'const' && start.offset === 0n) return null;
    if (start.kind === 'field-end' && start.fieldId) {
      return { kind: 'fixed', start: Number(start.offset), end: -1 };
    }
    if (start.kind === 'const') {
      return { kind: 'fixed', start: Number(start.offset), end: -1 };
    }
    return null;
  }
  if (start.kind === 'const' && start.offset === 0n && end.kind === 'field-start' && end.fieldId) {
    return { kind: 'prefixTo', endField: end.fieldId };
  }
  if (start.kind === 'field-end' && start.fieldId && end.kind === 'field-start' && end.fieldId) {
    return { kind: 'between', startField: start.fieldId, endField: end.fieldId };
  }
  if (start.kind === 'field-end' && start.fieldId && end.kind === 'field-end' && end.fieldId) {
    return { kind: 'fixed', start: Number(start.offset), end: Number(end.offset) };
  }
  if (start.kind === 'const' && end.kind === 'field-end' && end.fieldId) {
    return { kind: 'fixed', start: Number(start.offset), end: Number(end.offset) };
  }
  return null;
}

function signature(candidate: Omit<Candidate, 'id' | 'createdAt' | 'status'>): string {
  return JSON.stringify({ kind: candidate.kind, range: candidate.fieldRange, spec: candidate.spec });
}

function deduplicate(
  candidates: Array<Omit<Candidate, 'id' | 'createdAt' | 'status'>>,
): Array<Omit<Candidate, 'id' | 'createdAt' | 'status'>> {
  const seen = new Map<string, Omit<Candidate, 'id' | 'createdAt' | 'status'>>();
  for (const candidate of candidates) {
    const key = signature(candidate);
    const existing = seen.get(key);
    if (!existing || candidate.supportSampleIds.length > existing.supportSampleIds.length) {
      seen.set(key, candidate);
    }
  }
  return [...seen.values()];
}
