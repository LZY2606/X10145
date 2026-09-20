import { randomUUID } from 'node:crypto';
import type {
  Adjudication,
  AppState,
  Candidate,
  Draft,
  Hypothesis,
  Sample,
  Spec,
  ValidationRun,
} from '../core/types.js';
import { sha256 } from '../core/binary.js';
import { validateSpecOnBuffer } from '../core/validate.js';
import { discoverCandidates, candidateIdentity } from '../core/candidates.js';
import { buildVersion, DraftPublicationError } from '../core/draft.js';
import { createHash } from 'node:crypto';
import type { Storage } from './storage.js';

const uid = (prefix: string) => `${prefix}_${randomUUID()}`;

export class ServiceError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class Service {
  constructor(private storage: Storage) {}

  private get state(): AppState {
    return this.storage.getState();
  }

  private commit(next: AppState): AppState {
    this.storage.saveState(next);
    return next;
  }

  private buffersFor(
    state: AppState,
    sampleIds: string[],
  ): { sampleId: string; buf: Uint8Array }[] {
    return sampleIds.map((sampleId) => {
      const sample = state.samples[sampleId];
      if (!sample) throw new ServiceError(404, `样本 ${sampleId} 不存在`);
      return { sampleId, buf: this.storage.readBlob(sample.blobId) };
    });
  }

  /** Same-content samples share one blob; per-sample notes are kept separately. */
  async addSample(bytes: Uint8Array, note: string): Promise<{ sample: Sample; deduped: boolean }> {
    const hash = await sha256(bytes);
    const next = structuredClone(this.state);

    let existingBlobId: string | undefined;
    for (const blob of Object.values(next.blobs)) {
      if (blob.sha256 === hash) {
        existingBlobId = blob.id;
        break;
      }
    }

    const deduped = !!existingBlobId;
    const blobId = existingBlobId ?? uid('blob');
    if (!existingBlobId) {
      this.storage.writeBlob(blobId, bytes);
      next.blobs[blobId] = {
        id: blobId,
        sha256: hash,
        size: bytes.length,
        createdAt: new Date().toISOString(),
      };
    }

    const sample: Sample = {
      id: uid('sample'),
      blobId,
      note: note || (deduped ? `复用 blob ${blobId}` : `样本 ${Object.keys(next.samples).length + 1}`),
      createdAt: new Date().toISOString(),
    };
    next.samples[sample.id] = sample;

    // Existing hypotheses are never retroactively rewritten. Adding a sample
    // produces a NEW validation run for every hypothesis.
    this.rerunAll(next, 'sample_added');
    this.refreshCandidates(next);

    this.commit(next);
    return { sample, deduped };
  }

  removeSample(sampleId: string): void {
    const next = structuredClone(this.state);
    if (!next.samples[sampleId]) throw new ServiceError(404, '样本不存在');
    const blobId = next.samples[sampleId].blobId;
    delete next.samples[sampleId];
    const stillUsed = Object.values(next.samples).some((s) => s.blobId === blobId);
    if (!stillUsed) delete next.blobs[blobId];
    this.rerunAll(next, 'sample_removed');
    this.refreshCandidates(next);
    this.commit(next);
  }

  addHypothesis(input: {
    label: string;
    start: number;
    end: number;
    spec: Spec;
  }): { hypothesis: Hypothesis; run: ValidationRun } {
    if (!Number.isInteger(input.start) || !Number.isInteger(input.end) || input.start < 0 || input.end < input.start) {
      throw new ServiceError(400, '区间必须是非负半开整数区间 [start, end)');
    }
    this.validateSpecShape(input.spec, input.end - input.start);

    const next = structuredClone(this.state);
    const now = new Date().toISOString();
    const hyp: Hypothesis = {
      id: uid('hyp'),
      label: input.label.trim() || `字段 ${Object.keys(next.hypotheses).length + 1}`,
      start: input.start,
      end: input.end,
      spec: input.spec,
      createdAt: now,
      proposedWithSamples: Object.keys(next.samples).sort(),
      runIds: [],
    };
    next.hypotheses[hyp.id] = hyp;
    const run = this.runOne(next, hyp, 'proposal');
    this.refreshCandidates(next);
    this.commit(next);
    return { hypothesis: next.hypotheses[hyp.id], run: next.runs[run.id] };
  }

  private validateSpecShape(spec: Spec, span: number): void {
    switch (spec.kind) {
      case 'integer':
      case 'enum':
      case 'length':
      case 'checksum':
        if (![1, 2, 4, 8].includes(spec.size)) throw new ServiceError(400, '整数宽度必须是 1/2/4/8 字节');
        if (span !== spec.size) throw new ServiceError(400, `区间长度 ${span} 与声明宽度 ${spec.size} 不一致`);
        if (spec.kind === 'enum' && spec.members.length === 0) throw new ServiceError(400, '枚举至少需要一个成员');
        return;
      case 'offset_table':
        if (spec.count < 0 || ![2, 4, 8].includes(spec.entrySize)) {
          throw new ServiceError(400, '偏移表项数非负，项宽为 2/4/8');
        }
        if (span !== spec.count * spec.entrySize) {
          throw new ServiceError(400, `偏移表区间长度 ${span} 不等于 项宽*项数 ${spec.count * spec.entrySize}`);
        }
        return;
      case 'string':
        if (span === 0) throw new ServiceError(400, '字符串区间不能为空');
        return;
    }
  }

  manualRerun(hypothesisId: string): ValidationRun {
    const next = structuredClone(this.state);
    const hyp = next.hypotheses[hypothesisId];
    if (!hyp) throw new ServiceError(404, '假设不存在');
    const run = this.runOne(next, hyp, 'manual');
    this.commit(next);
    return next.runs[run.id];
  }

  private runOne(next: AppState, hyp: Hypothesis, trigger: ValidationRun['trigger']): ValidationRun {
    const sampleIds = Object.keys(next.samples).sort();
    const results = this.buffersFor(next, sampleIds).map(({ sampleId, buf }) =>
      validateSpecOnBuffer(hyp.spec, hyp.start, hyp.end, {
        buf,
        sampleId,
        hypotheses: next.hypotheses,
      }),
    );
    const run: ValidationRun = {
      id: uid('run'),
      hypothesisId: hyp.id,
      at: new Date().toISOString(),
      sampleSetAtProposal: [...hyp.proposedWithSamples],
      sampleSet: sampleIds,
      trigger,
      results,
      hits: results.filter((r) => r.verdict === 'hit').length,
      counterexamples: results.filter((r) => r.verdict === 'counterexample').length,
      outOfBounds: results.filter((r) => r.verdict === 'out_of_bounds').length,
    };
    next.runs[run.id] = run;
    next.hypotheses[hyp.id].runIds.push(run.id);
    return run;
  }

  private rerunAll(next: AppState, trigger: ValidationRun['trigger']): void {
    for (const hyp of Object.values(next.hypotheses)) {
      this.runOne(next, hyp, trigger);
    }
  }

  private refreshCandidates(next: AppState): void {
    const sampleIds = Object.keys(next.samples).sort();
    const buffers = this.buffersFor(next, sampleIds);
    const found = discoverCandidates(next, buffers);
    const activeSignatures = new Set(found.map(candidateIdentity));

    for (const candidate of found) {
      const identity = candidateIdentity(candidate);
      // Merge with an existing candidate that is not dismissed: counts refresh
      // (they can drop when a new sample breaks the relation), id is retained.
      const match = Object.values(next.candidates).find(
        (c) => candidateIdentity(c) === identity && c.status !== 'dismissed',
      );
      if (match) {
        match.supportSampleIds = candidate.supportSampleIds;
        match.supportCount = candidate.supportCount;
        match.totalSamples = candidate.totalSamples;
        match.updatedAt = candidate.updatedAt;
        // Refresh the live spec (e.g. inferred unit) while keeping confirmed state.
        if (match.status === 'proposed') match.spec = candidate.spec;
        continue;
      }
      // A previously dismissed relation that now shows up again stays dismissed.
      const previouslyDismissed = Object.values(next.candidates).find(
        (c) => candidateIdentity(c) === identity && c.status === 'dismissed',
      );
      if (previouslyDismissed) {
        previouslyDismissed.supportSampleIds = candidate.supportSampleIds;
        previouslyDismissed.supportCount = candidate.supportCount;
        previouslyDismissed.totalSamples = candidate.totalSamples;
        previouslyDismissed.updatedAt = candidate.updatedAt;
        continue;
      }
      next.candidates[candidate.id] = candidate;
    }

    // Proposed candidates whose supporting evidence vanished (new counterexample
    // samples) are marked stale so they can never be promoted against bad data.
    for (const candidate of Object.values(next.candidates)) {
      if (candidate.status === 'proposed' && !activeSignatures.has(candidateIdentity(candidate))) {
        candidate.status = 'dismissed';
        candidate.updatedAt = new Date().toISOString();
      }
    }
  }

  rerunDiscovery(): Candidate[] {
    const next = structuredClone(this.state);
    this.refreshCandidates(next);
    this.commit(next);
    return Object.values(next.candidates);
  }

  confirmCandidate(candidateId: string): { candidate: Candidate; hypothesis: Hypothesis; run: ValidationRun } {
    const next = structuredClone(this.state);
    const candidate = next.candidates[candidateId];
    if (!candidate) throw new ServiceError(404, '候选不存在');
    if (candidate.status === 'dismissed') throw new ServiceError(400, '候选已忽略，不能确认');
    candidate.status = 'confirmed';
    candidate.confirmedAt = new Date().toISOString();

    // Promoting a candidate creates a real hypothesis, which then follows the
    // normal validation workflow (and is explicitly added to a draft later).
    const hyp: Hypothesis = {
      id: uid('hyp'),
      label: `候选：${candidate.description.slice(0, 40)}`,
      start: candidate.start,
      end: candidate.end,
      spec: candidate.spec,
      createdAt: new Date().toISOString(),
      proposedWithSamples: Object.keys(next.samples).sort(),
      fromCandidateId: candidate.id,
      runIds: [],
    };
    next.hypotheses[hyp.id] = hyp;
    const run = this.runOne(next, hyp, 'proposal');
    this.commit(next);
    return { candidate: next.candidates[candidateId], hypothesis: next.hypotheses[hyp.id], run: next.runs[run.id] };
  }

  dismissCandidate(candidateId: string): void {
    const next = structuredClone(this.state);
    const candidate = next.candidates[candidateId];
    if (!candidate) throw new ServiceError(404, '候选不存在');
    candidate.status = 'dismissed';
    this.commit(next);
  }

  adjudicate(input: { a: string; b: string; winner: string; reason: string }): Adjudication {
    const next = structuredClone(this.state);
    const a = next.hypotheses[input.a];
    const b = next.hypotheses[input.b];
    if (!a || !b) throw new ServiceError(404, '被裁决的假设不存在');
    if (input.winner !== input.a && input.winner !== input.b) throw new ServiceError(400, '裁决胜者必须是重叠双方之一');
    const ids = [input.a, input.b].sort();
    const key = ids.join('|');
    const adjudication: Adjudication = {
      pairKey: key,
      a: ids[0],
      b: ids[1],
      winner: input.winner,
      reason: input.reason.trim() || '手动裁决',
      at: new Date().toISOString(),
    };
    next.adjudications[key] = adjudication;
    this.commit(next);
    return adjudication;
  }

  createDraft(name: string): Draft {
    const next = structuredClone(this.state);
    const now = new Date().toISOString();
    const draft: Draft = {
      id: uid('draft'),
      name: name.trim() || `格式草案 ${Object.keys(next.drafts).length + 1}`,
      createdAt: now,
      updatedAt: now,
      publishedVersion: null,
      versions: [],
    };
    next.drafts[draft.id] = draft;
    this.commit(next);
    return draft;
  }

  publishDraft(input: {
    draftId: string;
    hypothesisIds: string[];
    note: string;
  }): Draft {
    const next = structuredClone(this.state);
    const draft = next.drafts[input.draftId];
    if (!draft) throw new ServiceError(404, '草案不存在');
    for (const id of input.hypothesisIds) {
      if (!next.hypotheses[id]) throw new ServiceError(400, `假设 ${id} 不存在，不能进入草案`);
    }
    try {
      const { draft: updated } = buildVersion({
        draft,
        selectedHypothesisIds: input.hypothesisIds,
        state: next,
        note: input.note || `v${(draft.publishedVersion ?? 0) + 1}`,
        hasher: (canonical) => createHash('sha256').update(canonical, 'utf8').digest('hex'),
      });
      next.drafts[input.draftId] = updated;
      this.commit(next);
      return updated;
    } catch (err) {
      if (err instanceof DraftPublicationError) {
        throw new ServiceError(409, err.message);
      }
      throw err;
    }
  }
}
