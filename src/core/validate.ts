import type {
  BaseRef,
  ChecksumRange,
  ChecksumAlgorithm,
  Hypothesis,
  LengthTarget,
  SampleResult,
  Spec,
} from './types.js';
import { inBounds, readInt, resolveRelative, halfOpenValid } from './binary.js';

export interface ValidateContext {
  buf: Uint8Array;
  sampleId: string;
  /** All hypotheses, for region references. */
  hypotheses: Record<string, Hypothesis>;
}

function fail(
  ctx: ValidateContext,
  atOffset: number,
  detail: string,
  value = '',
  numeric?: number | number[],
): SampleResult {
  const verdict = atOffset >= ctx.buf.length || atOffset < 0 ? 'out_of_bounds' : 'counterexample';
  return { sampleId: ctx.sampleId, verdict, value, numeric, atOffset, detail };
}

function outOfBounds(ctx: ValidateContext, atOffset: number, detail: string): SampleResult {
  const clamped = Math.min(Math.max(atOffset, 0), ctx.buf.length);
  return { sampleId: ctx.sampleId, verdict: 'out_of_bounds', value: '', atOffset: clamped, detail };
}

function ok(ctx: ValidateContext, value: string, numeric?: number | number[]): SampleResult {
  return { sampleId: ctx.sampleId, verdict: 'hit', value, numeric };
}

function checksumBytes(
  buf: Uint8Array,
  ranges: ChecksumRange[],
  hypotheses: Record<string, Hypothesis>,
): { bytes: Uint8Array } | { error: string; atOffset: number } {
  const pieces: Uint8Array[] = [];
  for (const range of ranges) {
    if (range.kind === 'absolute') {
      if (!halfOpenValid(range.start, range.end)) {
        return { error: 'invalid checksum range', atOffset: range.start };
      }
      if (!inBounds(buf.length, range.start, range.end)) {
        return { error: 'checksum range out of bounds', atOffset: Math.min(range.start, buf.length) };
      }
      pieces.push(buf.subarray(range.start, range.end));
    } else {
      const ref = hypotheses[range.hypothesisId];
      if (!ref) return { error: 'checksum references missing region', atOffset: 0 };
      if (!inBounds(buf.length, ref.start, ref.end)) {
        return { error: 'referenced region out of bounds', atOffset: Math.min(ref.start, buf.length) };
      }
      pieces.push(buf.subarray(ref.start, ref.end));
    }
  }
  const total = pieces.reduce((acc, p) => acc + p.length, 0);
  const merged = new Uint8Array(total);
  let off = 0;
  for (const p of pieces) {
    merged.set(p, off);
    off += p.length;
  }
  return { bytes: merged };
}

function computeChecksum(bytes: Uint8Array, algorithm: ChecksumAlgorithm): number {
  if (algorithm === 'xor8') {
    let v = 0;
    for (const b of bytes) v ^= b;
    return v >>> 0;
  }
  if (algorithm === 'sum8') {
    let v = 0;
    for (const b of bytes) v = (v + b) & 0xff;
    return v;
  }
  // sum16: 16-bit word sum with zero padding for the trailing odd byte, little endian words.
  let v = 0;
  for (let i = 0; i < bytes.length; i += 2) {
    const lo = bytes[i];
    const hi = i + 1 < bytes.length ? bytes[i + 1] : 0;
    v = (v + lo + (hi << 8)) & 0xffff;
  }
  return v >>> 0;
}

function baseOffset(
  base: BaseRef,
  buf: Uint8Array,
  selfStart: number,
  hypotheses: Record<string, Hypothesis>,
): { offset: number } | { error: string; atOffset: number } {
  switch (base.kind) {
    case 'start':
      return { offset: 0 };
    case 'end':
      return { offset: buf.length };
    case 'field_start':
      return { offset: selfStart };
    case 'region': {
      const ref = hypotheses[base.hypothesisId];
      if (!ref) return { error: 'base references missing region', atOffset: 0 };
      if (!inBounds(buf.length, ref.start, ref.end)) {
        return { error: 'base region out of bounds', atOffset: Math.min(ref.start, buf.length) };
      }
      return { offset: ref.start };
    }
  }
}

function targetLength(
  target: LengthTarget,
  buf: Uint8Array,
  hypotheses: Record<string, Hypothesis>,
): { length: number } | { error: string; atOffset: number } {
  if (target.kind === 'file') return { length: buf.length };
  if (target.kind === 'eof_remaining') {
    if (!Number.isInteger(target.from) || target.from < 0) {
      return { error: 'invalid eof anchor', atOffset: 0 };
    }
    if (target.from > buf.length) {
      return { error: 'eof anchor out of bounds', atOffset: buf.length };
    }
    return { length: buf.length - target.from };
  }
  const ref = hypotheses[target.hypothesisId];
  if (!ref) return { error: 'length references missing region', atOffset: 0 };
  if (!inBounds(buf.length, ref.start, ref.end)) {
    return { error: 'target region out of bounds', atOffset: Math.min(ref.start, buf.length) };
  }
  return { length: ref.end - ref.start };
}

export function validateSpecOnBuffer(
  spec: Spec,
  start: number,
  end: number,
  ctx: ValidateContext,
): SampleResult {
  const { buf } = ctx;

  if (!halfOpenValid(start, end)) {
    return fail(ctx, start >= 0 ? start : 0, 'invalid half-open interval');
  }

  // Whole declared interval must fit.
  if (!inBounds(buf.length, start, end)) {
    return {
      sampleId: ctx.sampleId,
      verdict: 'out_of_bounds',
      value: '',
      atOffset: Math.min(end > buf.length ? buf.length : start, buf.length),
      detail: `interval [${start}, ${end}) exceeds sample size ${buf.length}`,
    };
  }

  switch (spec.kind) {
    case 'integer': {
      const width = spec.size;
      if (end - start !== width) {
        return fail(ctx, start, `integer width ${end - start} != declared ${width}`);
      }
      const r = readInt(buf, start, spec.size, spec.endian, spec.signed);
      if (!r.ok) return fail(ctx, r.atOffset ?? start, r.reason ?? 'read failed');
      return ok(ctx, String(r.value), r.value);
    }

    case 'string': {
      const bytes = buf.subarray(start, end);
      if (spec.requireNullTerminator) {
        if (bytes.length === 0 || bytes[bytes.length - 1] !== 0) {
          return fail(ctx, end - 1 >= 0 ? end - 1 : start, 'string is not NUL terminated');
        }
      }
      if (spec.allowPrintableOnly) {
        for (let i = 0; i < bytes.length; i++) {
          const b = bytes[i];
          if (b === 0) continue;
          if (b < 0x20 || b === 0x7f) {
            return fail(ctx, start + i, `non-printable byte 0x${b.toString(16).padStart(2, '0')}`);
          }
        }
      }
      try {
        const decoder = new TextDecoder(spec.encoding, { fatal: true });
        const decoded = decoder.decode(bytes);
        const printable = decoded.replace(/\0/g, '');
        return ok(ctx, JSON.stringify(printable));
      } catch {
        return fail(ctx, start, `bytes are not valid ${spec.encoding}`);
      }
    }

    case 'enum': {
      const width = spec.size;
      if (end - start !== width) {
        return fail(ctx, start, `enum width ${end - start} != declared ${width}`);
      }
      const r = readInt(buf, start, spec.size, spec.endian, spec.signed);
      if (!r.ok) return fail(ctx, r.atOffset ?? start, r.reason ?? 'read failed');
      const member = spec.members.find((m) => m.value === r.value);
      if (!member) {
        return fail(ctx, start, `value ${r.value} (0x${(r.value ?? 0).toString(16)}) is not an enum member`, String(r.value), r.value);
      }
      return ok(ctx, `${member.name}=${r.value}`, r.value);
    }

    case 'offset_table': {
      const span = end - start;
      const expected = spec.entrySize * spec.count;
      if (span !== expected) {
        return fail(ctx, start, `table span ${span} != ${spec.entrySize}*${spec.count}=${expected}`);
      }
      const base = baseOffset(spec.base, buf, start, ctx.hypotheses);
      if ('error' in base) return outOfBounds(ctx, base.atOffset, base.error);
      const targets: number[] = [];
      for (let i = 0; i < spec.count; i++) {
        const entryAt = start + i * spec.entrySize;
        const r = readInt(buf, entryAt, spec.entrySize, spec.endian, false);
        if (!r.ok) return fail(ctx, r.atOffset ?? entryAt, r.reason ?? 'entry read failed');
        const resolved = resolveRelative(r.value!, spec.unit, base.offset, buf.length);
        if (!resolved.ok) {
          return fail(ctx, entryAt, `entry ${i}: ${resolved.reason} (raw=${r.value})`, String(r.value), targets.concat(r.value!));
        }
        targets.push(resolved.offset);
      }
      return ok(ctx, targets.map((t) => '0x' + t.toString(16)).join(', '), targets);
    }

    case 'length': {
      if (end - start !== spec.size) {
        return fail(ctx, start, `length width ${end - start} != declared ${spec.size}`);
      }
      const r = readInt(buf, start, spec.size, spec.endian, spec.signed);
      if (!r.ok) return fail(ctx, r.atOffset ?? start, r.reason ?? 'read failed');
      const tgt = targetLength(spec.target, buf, ctx.hypotheses);
      if ('error' in tgt) return outOfBounds(ctx, tgt.atOffset, tgt.error);
      if (r.value! < 0) {
        return fail(ctx, start, `negative length ${r.value}`, String(r.value), r.value);
      }
      const scaled = r.value! * spec.unit;
      if (!Number.isSafeInteger(scaled)) {
        return fail(ctx, start, 'length unit multiplication overflow', String(r.value), r.value);
      }
      if (scaled !== tgt.length) {
        return fail(
          ctx,
          start,
          `length ${r.value}*${spec.unit}=${scaled} != target length ${tgt.length}`,
          String(r.value),
          r.value,
        );
      }
      return ok(ctx, `${r.value} (${scaled} bytes)`, r.value);
    }

    case 'checksum': {
      if (end - start !== spec.size) {
        return fail(ctx, start, `checksum width ${end - start} != declared ${spec.size}`);
      }
      const field = readInt(buf, start, spec.size, spec.endian, false);
      if (!field.ok) return fail(ctx, field.atOffset ?? start, field.reason ?? 'read failed');
      const covered = checksumBytes(buf, spec.ranges, ctx.hypotheses);
      if ('error' in covered) return outOfBounds(ctx, covered.atOffset, covered.error);
      const actual = computeChecksum(covered.bytes, spec.algorithm);
      if (field.value !== actual) {
        return fail(
          ctx,
          start,
          `stored 0x${field.value!.toString(16)} != computed ${spec.algorithm} 0x${actual.toString(16)}`,
          String(field.value),
          field.value,
        );
      }
      return ok(ctx, `0x${actual.toString(16)}`, field.value);
    }
  }
}

export function validateHypothesis(hyp: Hypothesis, ctx: ValidateContext): SampleResult {
  return validateSpecOnBuffer(hyp.spec, hyp.start, hyp.end, ctx);
}
