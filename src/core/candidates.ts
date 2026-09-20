import type {
  AppState,
  Candidate,
  ChecksumAlgorithm,
  Hypothesis,
  Spec,
  Unit,
} from './types.js';
import { readInt, overlaps } from './binary.js';

interface BufMap {
  sampleId: string;
  buf: Uint8Array;
}

const CHECKSUM_ALGORITHMS: ChecksumAlgorithm[] = ['sum8', 'sum16', 'xor8'];

const uid = (prefix: string): string => `${prefix}_${crypto.randomUUID()}`;

interface FieldValue {
  sampleId: string;
  buf: Uint8Array;
  value: number;
}

interface RelationSeed {
  kind: Candidate['kind'];
  start: number;
  end: number;
  description: (unit: Unit, supporters: FieldValue[], total: number) => string;
  buildSpec: (unit: Unit) => Spec;
  /** Identity signature used to merge re-discoveries over time. */
  signature: string;
  evaluate: (unit: Unit, fv: FieldValue) => boolean;
  units: Unit[];
}

/**
 * Proposes correlation candidates from declared integer fields:
 *  - length_relation: field * unit == length of a string/table region or file remainder
 *  - checksum_relation: field == simple checksum over another region
 *  - constant: same value in every sample
 * Every candidate carries its supporting sample count. A relationship needs
 * at least two supporting samples (or unanimity) to be surfaced, and support
 * counts are recomputed on every refresh so they can drop after new samples.
 * Candidates never enter a draft without explicit confirmation.
 */
export function discoverCandidates(
  state: AppState,
  buffers: BufMap[],
  now: string = new Date().toISOString(),
): Candidate[] {
  const integerHyps = Object.values(state.hypotheses).filter(
    (h) => h.spec.kind === 'integer' && h.end - h.start <= 8,
  );
  const regionHyps = Object.values(state.hypotheses).filter(
    (h) => h.spec.kind === 'string' || h.spec.kind === 'offset_table',
  );
  const out: Candidate[] = [];

  for (const field of integerHyps) {
    const spec = field.spec as Extract<Spec, { kind: 'integer' }>;
    const readable: FieldValue[] = [];
    for (const { sampleId, buf } of buffers) {
      const r = readInt(buf, field.start, spec.size, spec.endian, spec.signed);
      if (r.ok && r.value !== undefined && Number.isSafeInteger(r.value)) {
        readable.push({ sampleId, buf, value: r.value });
      }
    }
    if (readable.length === 0) continue;

    // ---- constant across every sample ----
    const allSame = readable.every((v) => v.value === readable[0].value);
    if (allSame && readable.length === buffers.length) {
      out.push(
        makeCandidate({
          signature: `constant|${field.start}|${field.end}|${readable[0].value}`,
          kind: 'constant',
          field,
          description: `${field.label} 恒等于 ${readable[0].value} (0x${readable[0].value.toString(16)})，覆盖全部 ${readable.length} 个样本`,
          spec: { kind: 'integer', endian: spec.endian, size: spec.size, signed: spec.signed },
          supporters: readable,
          total: buffers.length,
          now,
        }),
      );
    }

    const seeds: RelationSeed[] = [];

    // ---- length of another region (per-unit support) ----
    for (const region of regionHyps) {
      if (overlaps(field.start, field.end, region.start, region.end)) continue;
      seeds.push({
        kind: 'length_relation',
        start: field.start,
        end: field.end,
        units: [1, 2, 4],
        signature: `length:region|${field.start}|${field.end}|${region.id}`,
        description: (unit, supporters, total) =>
          `${field.label} 等于区域「${region.label}」的长度（${supporters.length}/${total} 样本支持，单位 ×${unit}）`,
        buildSpec: (unit) => ({
          kind: 'length',
          endian: spec.endian,
          size: spec.size,
          signed: spec.signed,
          unit,
          target: { kind: 'region', hypothesisId: region.id },
        }),
        evaluate: (unit, fv) => region.end <= fv.buf.length && fv.value * unit === region.end - region.start,
      });
    }

    // ---- length of remainder from field end to EOF ----
    if (readable.some((fv) => fv.buf.length - field.end > 0)) {
      seeds.push({
        kind: 'length_relation',
        start: field.start,
        end: field.end,
        units: [1, 2, 4],
        signature: `length:eof|${field.start}|${field.end}`,
        description: (unit, supporters, total) =>
          `${field.label} 等于其后到文件尾的长度（${supporters.length}/${total} 样本支持，单位 ×${unit}）`,
        buildSpec: (unit) => ({
          kind: 'length',
          endian: spec.endian,
          size: spec.size,
          signed: spec.signed,
          unit,
          target: { kind: 'eof_remaining', from: field.end },
        }),
        evaluate: (unit, fv) => fv.value * unit === fv.buf.length - field.end,
      });
    }

    // ---- checksum over another region ----
    if (spec.size <= 2) {
      for (const region of regionHyps) {
        if (overlaps(field.start, field.end, region.start, region.end)) continue;
        for (const algorithm of CHECKSUM_ALGORITHMS) {
          if (algorithm === 'sum16' && spec.size === 1) continue;
          if (algorithm !== 'sum16' && spec.size === 2) continue;
          seeds.push({
            kind: 'checksum_relation',
            start: field.start,
            end: field.end,
            units: [1],
            signature: `checksum|${field.start}|${field.end}|${algorithm}|${region.id}`,
            description: (_unit, supporters, total) =>
              `${field.label} 等于区域「${region.label}」的 ${algorithm} 校验值（${supporters.length}/${total} 样本支持）`,
            buildSpec: () => ({
              kind: 'checksum',
              endian: spec.endian,
              size: spec.size,
              algorithm,
              ranges: [{ kind: 'region', hypothesisId: region.id }],
            }),
            evaluate: (_unit, fv) =>
              region.end <= fv.buf.length && fv.value === compute(fv.buf.subarray(region.start, region.end), algorithm),
          });
        }
      }
    }

    for (const seed of seeds) {
      // Pick the unit with the strongest, smallest-unit support.
      let best: { unit: Unit; supporters: FieldValue[] } | null = null;
      for (const unit of seed.units) {
        const supporters = readable.filter((fv) => {
          const scaled = fv.value * unit;
          if (!Number.isSafeInteger(scaled)) return false;
          return seed.evaluate(unit, fv);
        });
        if (supporters.length === 0) continue;
        if (!best || supporters.length > best.supporters.length) best = { unit, supporters };
      }
      if (!best) continue;
      const unanimous = best.supporters.length === buffers.length;
      // Surface on unanimity (incl. single-sample) or at least two agreeing samples.
      if (!unanimous && best.supporters.length < 2) continue;
      out.push(
        makeCandidate({
          signature: seed.signature,
          kind: seed.kind,
          field,
          description: seed.description(best.unit, best.supporters, buffers.length),
          spec: seed.buildSpec(best.unit),
          supporters: unanimous ? best.supporters : best.supporters,
          total: buffers.length,
          now,
        }),
      );
    }
  }

  return out;
}

function compute(bytes: Uint8Array, algorithm: ChecksumAlgorithm): number {
  if (algorithm === 'xor8') {
    let v = 0;
    for (const b of bytes) v ^= b;
    return v >>> 0;
  }
  if (algorithm === 'sum8') {
    let v = 0;
    for (const b of bytes) v = (v + b) & 0xff;
    return v >>> 0;
  }
  let v = 0;
  for (let i = 0; i < bytes.length; i += 2) {
    const lo = bytes[i];
    const hi = i + 1 < bytes.length ? bytes[i + 1] : 0;
    v = (v + lo + (hi << 8)) & 0xffff;
  }
  return v >>> 0;
}

interface MakeArgs {
  signature: string;
  kind: Candidate['kind'];
  field: Hypothesis;
  description: string;
  spec: Spec;
  supporters: FieldValue[];
  total: number;
  now: string;
}

function makeCandidate(args: MakeArgs): Candidate {
  return {
    id: uid('cand'),
    kind: args.kind,
    start: args.field.start,
    end: args.field.end,
    description: args.description,
    spec: args.spec,
    supportSampleIds: args.supporters.map((s) => s.sampleId),
    supportCount: args.supporters.length,
    totalSamples: args.total,
    discoveredAt: args.now,
    updatedAt: args.now,
    status: 'proposed',
    // signature is carried on the spec-independent identity map keyed below
    ...({ signature: args.signature } as object),
  } as Candidate;
}

/** Identity of a candidate independent of its mutable support numbers. */
export function candidateIdentity(c: Candidate): string {
  return c.signature;
}
