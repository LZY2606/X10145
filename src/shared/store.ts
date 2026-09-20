import { bytesToBase64 } from './bytes';
import { discoverCandidates } from './candidates';
import { idFactory, verifyHypotheses, type SampleBlob } from './semantics';
import type {
  AppState,
  Candidate,
  DraftField,
  DraftVersion,
  Hypothesis,
  HypothesisConfig,
  HypothesisType,
  OverlapAdjudication,
  SampleRecord,
  StableDraftExport,
  Verification,
} from './types';

export function emptyState(): AppState {
  return {
    blobs: {},
    samples: {},
    sampleOrder: [],
    hypotheses: {},
    verifications: [],
    candidates: {},
    drafts: [],
    sequence: 0,
  };
}

export function cloneState(state: AppState): AppState {
  return structuredClone(state);
}

function nextId(state: AppState, prefix: string): string {
  return idFactory(state)(prefix);
}

function sha256Hex(bytes: Uint8Array): string {
  const hash = new Sha256();
  return hash.hex(bytes);
}

/** Minimal dependency-free SHA-256 (works in browser and Node). */
class Sha256 {
  private static readonly K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);

  hex(message: Uint8Array): string {
    const h = new Uint32Array([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
      0x1f83d9ab, 0x5be0cd19,
    ]);
    const bitLength = BigInt(message.length) * 8n;
    const paddedLength = Math.ceil((message.length + 9) / 64) * 64;
    const padded = new Uint8Array(paddedLength);
    padded.set(message);
    padded[message.length] = 0x80;
    const view = new DataView(padded.buffer);
    view.setUint32(paddedLength - 4, Number(bitLength & 0xffffffffn));
    view.setUint32(paddedLength - 8, Number((bitLength >> 32n) & 0xffffffffn));
    const w = new Uint32Array(64);
    for (let offset = 0; offset < paddedLength; offset += 64) {
      for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
      for (let i = 16; i < 64; i++) {
        const s0 =
          rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 =
          rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      let [a, b, c, d, e, f, g, hh] = h;
      for (let i = 0; i < 64; i++) {
        const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const ch = (e & f) ^ (~e & g);
        const temp1 = (hh + S1 + ch + Sha256.K[i] + w[i]) >>> 0;
        const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const temp2 = (S0 + maj) >>> 0;
        hh = g;
        g = f;
        f = e;
        e = (d + temp1) >>> 0;
        d = c;
        c = b;
        b = a;
        a = (temp1 + temp2) >>> 0;
      }
      h[0] = (h[0] + a) >>> 0;
      h[1] = (h[1] + b) >>> 0;
      h[2] = (h[2] + c) >>> 0;
      h[3] = (h[3] + d) >>> 0;
      h[4] = (h[4] + e) >>> 0;
      h[5] = (h[5] + f) >>> 0;
      h[6] = (h[6] + g) >>> 0;
      h[7] = (h[7] + hh) >>> 0;
    }
    return [...h].map((value) => value.toString(16).padStart(8, '0')).join('');
  }
}

function rotr(value: number, shift: number): number {
  return (value >>> shift) | (value << (32 - shift));
}

export interface AddSampleInput {
  name: string;
  note: string;
  bytes: Uint8Array;
}

export interface AddSampleResult {
  sample: SampleRecord;
  reusedBlob: boolean;
  verifications: Verification[];
}

/**
 * Add a sample. Identical content shares one blob; source notes stay on the
 * sample record. Adding samples appends new verification results — earlier
 * verification records are never rewritten.
 */
export function addSample(state: AppState, input: AddSampleInput, blobs: Map<string, SampleBlob>): AddSampleResult {
  const base64 = bytesToBase64(input.bytes);
  const sha = sha256Hex(input.bytes);
  const reusedBlob = Boolean(state.blobs[sha]);
  if (!reusedBlob) {
    state.blobs[sha] = {
      sha256: sha,
      size: input.bytes.length,
      base64,
      firstSeenAt: new Date().toISOString(),
    };
  }
  const id = nextId(state, 'sample');
  const sample: SampleRecord = {
    id,
    blobSha256: sha,
    name: input.name,
    note: input.note,
    uploadedAt: new Date().toISOString(),
  };
  state.samples[id] = sample;
  state.sampleOrder.push(id);
  blobs.set(id, { sample, bytes: input.bytes });

  const verifications = runVerification(state, blobs);
  return { sample, reusedBlob, verifications };
}

export interface AddHypothesisInput {
  name: string;
  type: HypothesisType;
  range: { start: number; end: number };
  config: HypothesisConfig;
  createdFromCandidateId?: string;
}

export function addHypothesis(
  state: AppState,
  blobs: Map<string, SampleBlob>,
  input: AddHypothesisInput,
): { hypothesis: Hypothesis; verifications: Verification[] } {
  validateRange(input.range);
  const id = nextId(state, 'hyp');
  const config = resolveSelfRefs(structuredClone(input.config), id);
  const hypothesis: Hypothesis = {
    id,
    name: input.name,
    type: input.type,
    range: { ...input.range },
    config,
    createdAt: new Date().toISOString(),
    proposedWithSampleIds: [...state.sampleOrder],
    createdFromCandidateId: input.createdFromCandidateId,
  };
  state.hypotheses[id] = hypothesis;
  const verifications = runVerification(state, blobs, { hypothesisId: id });
  return { hypothesis, verifications };
}

export function retireHypothesis(state: AppState, id: string): void {
  const hypothesis = state.hypotheses[id];
  if (hypothesis) hypothesis.retired = true;
}


function resolveSelfRefs(config: HypothesisConfig, selfId: string): HypothesisConfig {
  const fixRegion = (region: any) => {
    if (region.endField === '__SELF__') region.endField = selfId;
    if (region.startField === '__SELF__') region.startField = selfId;
    if (region.lengthField === '__SELF__') region.lengthField = selfId;
    if (region.startField === '__SELF__') region.startField = selfId;
    return region;
  };
  if (config.type === 'length') fixRegion(config.region);
  if (config.type === 'checksum') config.covered.forEach(fixRegion);
  return config;
}

function validateRange(range: { start: number; end: number }): void {
  if (
    !Number.isSafeInteger(range.start) ||
    !Number.isSafeInteger(range.end) ||
    range.start < 0 ||
    range.end < range.start
  ) {
    throw new Error(`非法半开区间 [${range.start},${range.end})`);
  }
}

export function runVerification(
  state: AppState,
  blobs: Map<string, SampleBlob>,
  options: { hypothesisId?: string } = {},
): Verification[] {
  const list = verifyHypotheses(state, blobs, options);
  state.verifications.push(...list);
  return list;
}

export function refreshCandidates(
  state: AppState,
  blobs: Map<string, SampleBlob>,
): Candidate[] {
  const discovered = discoverCandidates(state, [...blobs.values()]);
  const existingSignatures = new Map<string, Candidate>();
  for (const candidate of Object.values(state.candidates)) {
    existingSignatures.set(stableSignature(candidate), candidate);
  }
  const created: Candidate[] = [];
  for (const item of discovered) {
    const signature = JSON.stringify({ kind: item.kind, range: item.fieldRange, spec: item.spec });
    if (existingSignatures.has(signature)) continue;
    const id = nextId(state, 'cand');
    const candidate: Candidate = {
      id,
      kind: item.kind,
      fieldRange: item.fieldRange,
      summary: item.summary,
      spec: item.spec,
      supportSampleIds: item.supportSampleIds,
      opposingSampleIds: item.opposingSampleIds,
      status: 'proposed',
      createdAt: new Date().toISOString(),
    };
    state.candidates[id] = candidate;
    created.push(candidate);
  }
  return created;
}

function stableSignature(candidate: Candidate): string {
  return JSON.stringify({ kind: candidate.kind, range: candidate.fieldRange, spec: candidate.spec });
}

export function dismissCandidate(state: AppState, id: string): void {
  const candidate = state.candidates[id];
  if (candidate) candidate.status = 'dismissed';
}

/**
 * Confirming a candidate creates a real hypothesis (and verifies it).
 * Confirmed candidates never enter a draft by themselves.
 */
export function confirmCandidate(
  state: AppState,
  blobs: Map<string, SampleBlob>,
  candidateId: string,
  name: string,
): { candidate: Candidate; hypothesis: Hypothesis } {
  const candidate = state.candidates[candidateId];
  if (!candidate) throw new Error('候选不存在');
  if (candidate.status !== 'proposed') throw new Error('候选已处理');
  const { hypothesis } = addHypothesis(state, blobs, {
    name,
    type: candidate.kind === 'offset' ? 'offset' : candidate.kind,
    range: { ...candidate.fieldRange },
    config: candidate.spec,
    createdFromCandidateId: candidate.id,
  });
  candidate.status = 'confirmed';
  candidate.confirmedHypothesisId = hypothesis.id;
  return { candidate, hypothesis };
}

export interface OverlapPair {
  fieldA: DraftField;
  fieldB: DraftField;
  overlap: { start: number; end: number };
}

export function fieldsFromHypotheses(
  hypotheses: Record<string, Hypothesis>,
  hypothesisIds: string[],
): DraftField[] {
  return hypothesisIds.map((hypothesisId) => {
    const hypothesis = hypotheses[hypothesisId];
    if (!hypothesis) throw new Error(`假设 ${hypothesisId} 不存在`);
    if (hypothesis.retired) throw new Error(`假设 ${hypothesis.name} 已停用`);
    return {
      id: `field_${hypothesis.id}`,
      name: hypothesis.name,
      kind: hypothesis.type,
      range: { ...hypothesis.range },
      config: structuredClone(hypothesis.config),
      sourceHypothesisId: hypothesis.id,
    };
  });
}

export function findOverlaps(fields: DraftField[]): OverlapPair[] {
  const pairs: OverlapPair[] = [];
  for (let i = 0; i < fields.length; i++) {
    for (let j = i + 1; j < fields.length; j++) {
      const a = fields[i];
      const b = fields[j];
      if (a.range.start < b.range.end && b.range.start < a.range.end) {
        pairs.push({
          fieldA: a,
          fieldB: b,
          overlap: {
            start: Math.max(a.range.start, b.range.start),
            end: Math.min(a.range.end, b.range.end),
          },
        });
      }
    }
  }
  return pairs;
}

export interface PublishDraftInput {
  hypothesisIds: string[];
  label: string;
  notes: string;
  /** Explicit winner field id for every unresolved overlap pair. */
  adjudications: Array<{ fieldAId: string; fieldBId: string; winnerFieldId: string }>;
}

/**
 * Publish a versioned draft. Overlapping interpretations may be staged on
 * hypotheses, but a draft must adjudicate every overlap explicitly.
 */
export function publishDraft(state: AppState, input: PublishDraftInput): DraftVersion {
  const fields = fieldsFromHypotheses(state.hypotheses, input.hypothesisIds);
  const overlaps = findOverlaps(fields);
  const adjudications: OverlapAdjudication[] = [];
  const losers = new Set<string>();

  for (const pair of overlaps) {
    const decision = input.adjudications.find(
      (item) =>
        (item.fieldAId === pair.fieldA.id && item.fieldBId === pair.fieldB.id) ||
        (item.fieldAId === pair.fieldB.id && item.fieldBId === pair.fieldA.id),
    );
    if (!decision) {
      throw new Error(
        `存在未裁决的重叠解释: “${pair.fieldA.name}” 与 “${pair.fieldB.name}” 在 [${pair.overlap.start},${pair.overlap.end}) 重叠`,
      );
    }
    if (decision.winnerFieldId !== pair.fieldA.id && decision.winnerFieldId !== pair.fieldB.id) {
      throw new Error('裁决必须选择两个重叠字段之一');
    }
    const loserId = decision.winnerFieldId === pair.fieldA.id ? pair.fieldB.id : pair.fieldA.id;
    losers.add(loserId);
    adjudications.push({
      at: new Date().toISOString(),
      fieldIds: [pair.fieldA.id, pair.fieldB.id],
      winnerFieldId: decision.winnerFieldId,
      range: { ...pair.overlap },
    });
  }

  const surviving = fields.filter((field) => !losers.has(field.id));
  const version = state.drafts.length === 0 ? 1 : state.drafts[state.drafts.length - 1].version + 1;
  const id = nextId(state, 'draft');
  const draft: DraftVersion = {
    id,
    version,
    label: input.label,
    notes: input.notes,
    createdAt: new Date().toISOString(),
    fieldIds: surviving.map((field) => field.id),
    fields: surviving,
    adjudications,
  };
  state.drafts.push(draft);
  return draft;
}

export function exportDraft(draft: DraftVersion): StableDraftExport {
  return {
    schema: 'binary-format-inference-bench/draft',
    schemaVersion: 1,
    draft: structuredClone(draft),
  };
}

export function stableExportJson(draft: DraftVersion): string {
  return JSON.stringify(exportDraft(draft), stableReplacer, 2) + '\n';
}

function stableReplacer(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
    );
  }
  return value;
}
