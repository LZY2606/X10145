// Standalone parser engine. This file has zero imports so it can be embedded
// verbatim into generated parsers. It only parses according to an already
// published draft and reports out-of-bounds/overflow errors with a JSON path
// plus byte offset instead of throwing.

export interface ParseError {
  ok: false;
  path: string;
  offset: number;
  code: 'out_of_bounds' | 'overflow' | 'invalid_enum' | 'invalid_string';
  message: string;
}

export interface ParseSuccess {
  ok: true;
  value: Record<string, FieldValue>;
  bytesConsumed: number;
}

export type ParseResult = ParseSuccess | ParseError;

export type FieldValue =
  | { type: 'integer'; value: number }
  | { type: 'string'; value: string }
  | { type: 'enum'; name: string; value: number }
  | { type: 'offset_table'; targets: number[] }
  | { type: 'length'; value: number; bytes: number }
  | { type: 'checksum'; value: number };

interface AnySpec {
  kind: string;
  endian?: 'le' | 'be';
  size?: number;
  signed?: boolean;
  encoding?: string;
  requireNullTerminator?: boolean;
  allowPrintableOnly?: boolean;
  members?: { name: string; value: number }[];
  entrySize?: number;
  count?: number;
  base?: { kind: string; hypothesisId?: string };
  unit?: number;
  target?: { kind: string; hypothesisId?: string; from?: number };
  algorithm?: string;
  ranges?: { kind: string; start?: number; end?: number; hypothesisId?: string }[];
}

interface DraftFieldLike {
  hypothesisId: string;
  label: string;
  start: number;
  end: number;
  spec: AnySpec;
}

interface DraftLike {
  format: string;
  fields: DraftFieldLike[];
}

type Bytes = Uint8Array;

function readInt(
  buf: Bytes,
  start: number,
  size: number,
  endian: 'le' | 'be',
  signed: boolean,
): { ok: true; value: number } | { ok: false; overflow: boolean } {
  if (start < 0 || start + size > buf.length) return { ok: false, overflow: false };
  let raw = 0;
  const useBig = size > 6;
  if (useBig) {
    // Still parse for completeness but values above 6 bytes may lose precision;
    // treat as overflow when beyond safe integer range.
    let big = 0n;
    if (endian === 'be') for (let i = 0; i < size; i++) big = (big << 8n) | BigInt(buf[start + i]);
    else for (let i = size - 1; i >= 0; i--) big = (big << 8n) | BigInt(buf[start + i]);
    if (signed) {
      const sign = 1n << BigInt(size * 8 - 1);
      if (big & sign) big -= 1n << BigInt(size * 8);
    }
    if (big > BigInt(Number.MAX_SAFE_INTEGER) || big < BigInt(Number.MIN_SAFE_INTEGER)) {
      return { ok: false, overflow: true };
    }
    return { ok: true, value: Number(big) };
  }
  if (endian === 'be') {
    for (let i = 0; i < size; i++) raw = raw * 256 + buf[start + i];
  } else {
    for (let i = size - 1; i >= 0; i--) raw = raw * 256 + buf[start + i];
  }
  if (signed) {
    const signBit = 1 << (size * 8 - 1);
    if (raw & signBit) raw -= 1 << (size * 8);
  }
  return { ok: true, value: raw };
}

export function parseWithDraft(input: Bytes | number[], draft: DraftLike): ParseResult {
  const buf: Bytes = input instanceof Uint8Array ? input : Uint8Array.from(input);
  const value: Record<string, FieldValue> = {};
  const byId: Record<string, DraftFieldLike> = {};
  for (const f of draft.fields) byId[f.hypothesisId] = f;

  const resolveBase = (spec: AnySpec, selfStart: number): number => {
    const base = spec.base ?? { kind: 'start' };
    if (base.kind === 'start') return 0;
    if (base.kind === 'end') return buf.length;
    if (base.kind === 'field_start') return selfStart;
    const ref = base.hypothesisId ? byId[base.hypothesisId] : undefined;
    if (!ref) return NaN;
    return ref.start;
  };

  const checksumBytes = (spec: AnySpec): Uint8Array | null => {
    const pieces = [];
    for (const r of spec.ranges ?? []) {
      let rs: number;
      let re: number;
      if (r.kind === 'absolute') {
        if (typeof r.start !== 'number' || typeof r.end !== 'number') return null;
        rs = r.start;
        re = r.end;
      } else {
        const ref = r.hypothesisId ? byId[r.hypothesisId] : undefined;
        if (!ref) return null;
        rs = ref.start;
        re = ref.end;
      }
      if (rs < 0 || re > buf.length || rs > re) return null;
      pieces.push(buf.subarray(rs, re));
    }
    if (pieces.length === 0) return null;
    const total = pieces.reduce((n, p) => n + p.length, 0);
    const merged = new Uint8Array(total);
    let off = 0;
    for (const p of pieces) { merged.set(p, off); off += p.length; }
    return merged;
  };

  let bytesConsumed = 0;

  for (const field of draft.fields) {
    const path = `$.${field.label}`;
    const { start, end } = field;
    const spec = field.spec;
    bytesConsumed = Math.max(bytesConsumed, end);

    if (start < 0 || end < start || end > buf.length) {
      return {
        ok: false,
        path,
        offset: Math.min(Math.max(end > buf.length ? buf.length : start, 0), buf.length),
        code: 'out_of_bounds',
        message: `字段区间 [${start}, ${end}) 超出输入长度 ${buf.length}`,
      };
    }

    if (spec.kind === 'integer' || spec.kind === 'enum' || spec.kind === 'length' || spec.kind === 'checksum') {
      const r = readInt(buf, start, spec.size ?? 1, spec.endian ?? 'le', !!spec.signed);
      if (!r.ok) {
        return {
          ok: false,
          path,
          offset: start,
          code: r.overflow ? 'overflow' : 'out_of_bounds',
          message: `${path} 整数读取${r.overflow ? '溢出安全整数范围' : '越界'}`,
        };
      }
      if (spec.kind === 'integer') value[field.label] = { type: 'integer', value: r.value };
      if (spec.kind === 'enum') {
        const member = (spec.members ?? []).find((m) => m.value === r.value);
        if (!member) {
          return {
            ok: false,
            path,
            offset: start,
            code: 'invalid_enum',
            message: `${path} 的值 ${r.value} 不在枚举成员中`,
          };
        }
        value[field.label] = { type: 'enum', name: member.name, value: r.value };
      }
      if (spec.kind === 'length') {
        const unit = spec.unit ?? 1;
        const bytes = r.value * unit;
        if (!Number.isSafeInteger(bytes)) {
          return { ok: false, path, offset: start, code: 'overflow', message: `${path} 长度乘以单位溢出` };
        }
        let expected = buf.length;
        if (spec.target?.kind === 'eof_remaining') expected = buf.length - (spec.target.from ?? 0);
        else if (spec.target?.kind === 'region') {
          const ref = spec.target.hypothesisId ? byId[spec.target.hypothesisId] : undefined;
          expected = ref ? ref.end - ref.start : NaN;
        }
        if (bytes !== expected) {
          return {
            ok: false,
            path,
            offset: start,
            code: 'out_of_bounds',
            message: `${path} 声明长度 ${bytes} 与目标长度 ${expected} 不一致`,
          };
        }
        value[field.label] = { type: 'length', value: r.value, bytes };
      }
      if (spec.kind === 'checksum') {
        const covered = checksumBytes(spec);
        if (!covered) {
          return { ok: false, path, offset: start, code: 'out_of_bounds', message: `${path} 校验区间越界或引用缺失` };
        }
        const actual = computeChecksum(covered, spec.algorithm ?? 'sum8');
        if (actual !== (r.value >>> 0) && actual !== r.value) {
          return {
            ok: false,
            path,
            offset: start,
            code: 'out_of_bounds',
            message: `${path} 存储校验值 ${r.value} 与计算值 ${actual} 不一致`,
          };
        }
        value[field.label] = { type: 'checksum', value: r.value };
      }
      continue;
    }

    if (spec.kind === 'string') {
      const raw = buf.subarray(start, end);
      if (spec.requireNullTerminator && (raw.length === 0 || raw[raw.length - 1] !== 0)) {
        return { ok: false, path, offset: end - 1, code: 'invalid_string', message: `${path} 缺少 NUL 终止符` };
      }
      if (spec.allowPrintableOnly) {
        for (let i = 0; i < raw.length; i++) {
          const b = raw[i];
          if (b !== 0 && (b < 0x20 || b === 0x7f)) {
            return { ok: false, path, offset: start + i, code: 'invalid_string', message: `${path} 含不可打印字节` };
          }
        }
      }
      try {
        const text = new TextDecoder(spec.encoding === 'utf8' ? 'utf-8' : 'ascii', { fatal: true }).decode(raw);
        value[field.label] = { type: 'string', value: text.replace(/\0+$/, '') };
      } catch {
        return { ok: false, path, offset: start, code: 'invalid_string', message: `${path} 不是合法 ${spec.encoding} 文本` };
      }
      continue;
    }

    if (spec.kind === 'offset_table') {
      const entrySize = spec.entrySize ?? 4;
      const count = spec.count ?? 0;
      const unit = spec.unit ?? 1;
      const base = resolveBase(spec, start);
      if (Number.isNaN(base)) {
        return { ok: false, path, offset: start, code: 'out_of_bounds', message: `${path} 基准点引用缺失` };
      }
      const targets: number[] = [];
      for (let i = 0; i < count; i++) {
        const at = start + i * entrySize;
        const r = readInt(buf, at, entrySize, spec.endian ?? 'le', false);
        if (!r.ok) {
          return {
            ok: false,
            path: `${path}[${i}]`,
            offset: at,
            code: r.overflow ? 'overflow' : 'out_of_bounds',
            message: `${path}[${i}] 偏移项读取失败`,
          };
        }
        const scaled = r.value * unit;
        const abs = base + scaled;
        if (!Number.isSafeInteger(scaled) || !Number.isSafeInteger(abs) || abs < 0 || abs > buf.length) {
          return {
            ok: false,
            path: `${path}[${i}]`,
            offset: Math.min(Math.max(abs, 0), buf.length),
            code: 'out_of_bounds',
            message: `${path}[${i}] 解析出的目标偏移 0x${Math.max(abs, 0).toString(16)} 越界（raw=${r.value}, unit=${unit}, base=0x${base.toString(16)}）`,
          };
        }
        targets.push(abs);
      }
      value[field.label] = { type: 'offset_table', targets };
      continue;
    }
  }

  return { ok: true, value, bytesConsumed };
}

function computeChecksum(bytes: Bytes, algorithm: string): number {
  if (algorithm === 'xor8') {
    let v = 0;
    for (const b of bytes) v ^= b;
    return v >>> 0;
  }
  if (algorithm === 'sum16') {
    let v = 0;
    for (let i = 0; i < bytes.length; i += 2) {
      const lo = bytes[i];
      const hi = i + 1 < bytes.length ? bytes[i + 1] : 0;
      v = (v + lo + (hi << 8)) & 0xffff;
    }
    return v >>> 0;
  }
  let v = 0;
  for (const b of bytes) v = (v + b) & 0xff;
  return v >>> 0;
}
