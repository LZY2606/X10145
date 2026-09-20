import { describe, expect, it } from 'vitest';
import { harness } from './helpers';
import { confirmCandidate, refreshCandidates } from '../src/shared/store';

describe('候选关系发现与确认', () => {
  it('能从跨样本相关性提出长度候选，标注支持数，未确认前不进入草案', () => {
    const h = harness();
    // [len][payload len 字节]
    h.add('a', [0x04, 0x41, 0x42, 0x43, 0x44]);
    h.add('b', [0x02, 0x58, 0x59]);
    h.hyp(h.state, h.blobs, {
      name: 'len_field',
      type: 'integer',
      range: { start: 0, end: 1 },
      config: { type: 'integer', intKind: 'u8', endian: 'little' },
    });

    const created = refreshCandidates(h.state, h.blobs);
    const lengthCandidates = created.filter((candidate) => candidate.kind === 'length');
    expect(lengthCandidates.length).toBeGreaterThan(0);
    const best = lengthCandidates[0];
    expect(best.supportSampleIds).toHaveLength(2);
    expect(best.opposingSampleIds).toHaveLength(0);
    expect(best.status).toBe('proposed');

    // 候选不直接出现在假设/草案中
    const draftsBefore = h.state.drafts.length;
    expect(draftsBefore).toBe(0);

    const confirmed = confirmCandidate(h.state, h.blobs, best.id, 'body_length');
    expect(confirmed.hypothesis.name).toBe('body_length');
    expect(h.state.candidates[best.id].status).toBe('confirmed');
    expect(confirmed.hypothesis.createdFromCandidateId).toBe(best.id);
    // 确认后立即完成全样本验证，两份样本均命中
    const verification = h.state.verifications.filter((v) => v.hypothesisId === confirmed.hypothesis.id).at(-1)!;
    expect(verification.hitSampleIds).toHaveLength(2);
  });

  it('校验和候选覆盖 xor8 场景', () => {
    const h = harness();
    const payloadA = [0x10, 0x20, 0x30];
    const payloadB = [0x11, 0x22, 0x33];
    const xor = (arr: number[]) => arr.reduce((acc, value) => acc ^ value, 0);
    h.add('a', [...payloadA, xor(payloadA)]);
    h.add('b', [...payloadB, xor(payloadB)]);
    h.hyp(h.state, h.blobs, {
      name: 'chk',
      type: 'integer',
      range: { start: 3, end: 4 },
      config: { type: 'integer', intKind: 'u8', endian: 'little' },
    });
    const created = refreshCandidates(h.state, h.blobs);
    const checksumCandidates = created.filter((candidate) => candidate.kind === 'checksum');
    expect(checksumCandidates.some((candidate) => candidate.summary.includes('xor8'))).toBe(true);
    const candidate = checksumCandidates.find((c) => c.summary.includes('xor8'))!;
    expect(candidate.supportSampleIds).toHaveLength(2);
  });

  it('只有一份样本支持的关系不会成为候选', () => {
    const h = harness();
    h.add('a', [0x04, 1, 2, 3, 4]);
    h.hyp(h.state, h.blobs, {
      name: 'len_field',
      type: 'integer',
      range: { start: 0, end: 1 },
      config: { type: 'integer', intKind: 'u8', endian: 'little' },
    });
    const created = refreshCandidates(h.state, h.blobs);
    expect(created).toHaveLength(0);
  });
});
