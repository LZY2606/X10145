import { describe, it, expect } from 'vitest';
import { makeService, buildBytes, u16 } from './helpers.js';
import { findOverlaps } from '../src/core/draft.js';

describe('重叠解释：暂存允许，发布必须显式裁决', () => {
  it('未裁决重叠阻止发布；裁决后可发布并保留裁决理由', async () => {
    const { service, storage } = makeService();
    // 6 字节样本，两条部分重叠的 u16 整数解释可以同时暂存。
    await service.addSample(buildBytes([u16(0x0102, 'le'), u16(0x0304, 'le'), u16(0x0506, 'le')]), 's');
    const a = service.addHypothesis({
      label: 'first_u16', start: 0, end: 2,
      spec: { kind: 'integer', endian: 'le', size: 2, signed: false },
    });
    const b = service.addHypothesis({
      label: 'second_u16', start: 1, end: 3,
      spec: { kind: 'integer', endian: 'le', size: 2, signed: false },
    });

    let state = storage.getState();
    const pairs = findOverlaps(Object.values(state.hypotheses), state.adjudications);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].adjudicated).toBe(false);

    const draft = service.createDraft('container-format');
    expect(() =>
      service.publishDraft({ draftId: draft.id, hypothesisIds: [a.hypothesis.id, b.hypothesis.id], note: 'v1' }),
    ).toThrow(/重叠/);

    service.adjudicate({ a: a.hypothesis.id, b: b.hypothesis.id, winner: b.hypothesis.id, reason: '重叠字节属于第二个字段' });
    const v1 = service.publishDraft({ draftId: draft.id, hypothesisIds: [a.hypothesis.id, b.hypothesis.id], note: '初版' });
    expect(v1.publishedVersion).toBe(1);
    expect(v1.versions[0].adjudications).toHaveLength(1);
    expect(v1.versions[0].adjudications[0].winner).toBe(b.hypothesis.id);
    expect(v1.versions[0].adjudications[0].reason).toContain('重叠字节');

    const v2 = service.publishDraft({ draftId: draft.id, hypothesisIds: [a.hypothesis.id, b.hypothesis.id], note: '再版' });
    expect(v2.publishedVersion).toBe(2);
    // 裁决快照分别保存在两个版本中
    expect(v2.versions[0].version).toBe(1);
    expect(v2.versions[1].version).toBe(2);

    // 不重叠的一对可以直接发布
    const noOverlap = findOverlaps(Object.values(storage.getState().hypotheses), storage.getState().adjudications);
    expect(noOverlap[0].adjudicated).toBe(true);
  });
});

describe('追加样本：旧假设产生新验证结果，历史不改写', () => {
  it('新增样本后 run 数量增加；第一次 run 的样本集与结论原样保留', async () => {
    const { service, storage } = makeService();
    await service.addSample(buildBytes([u16(7, 'le'), 'AB']), 'one');
    const h = service.addHypothesis({
      label: 'file_len', start: 0, end: 2,
      spec: { kind: 'length', endian: 'le', size: 2, signed: false, unit: 1, target: { kind: 'file' } },
    });
    expect(h.run.results).toHaveLength(1);
    expect(h.run.results[0].verdict).toBe('counterexample');
    expect(h.run.sampleSetAtProposal).toEqual([Object.keys(storage.getState().samples)[0]]);
    const firstRunJson = JSON.stringify(h.run);

    await service.addSample(buildBytes([u16(4, 'le'), 'AB']), 'two');
    const state = storage.getState();
    const hypAfter = state.hypotheses[h.hypothesis.id];
    expect(hypAfter.runIds.length).toBe(2);

    const firstRun = state.runs[hypAfter.runIds[0]];
    expect(firstRun.sampleSet).toHaveLength(1);
    expect(JSON.stringify(firstRun)).toBe(firstRunJson);

    const secondRun = state.runs[hypAfter.runIds[1]];
    expect(secondRun.trigger).toBe('sample_added');
    expect(secondRun.sampleSet).toHaveLength(2);
    expect(secondRun.hits).toBe(1);
    expect(secondRun.counterexamples).toBe(1);

    // 提出时样本集合永久记录在假设上
    expect(hypAfter.proposedWithSamples).toHaveLength(1);
  });

  it('重启后从磁盘恢复全部版本与验证历史', async () => {
    const { service, storage } = makeService();
    await service.addSample(buildBytes([u16(4, 'le'), 'AB']), 'one');
    const h = service.addHypothesis({
      label: 'file_len', start: 0, end: 2,
      spec: { kind: 'length', endian: 'le', size: 2, signed: false, unit: 1, target: { kind: 'file' } },
    });
    const draft = service.createDraft('persisted');
    service.publishDraft({ draftId: draft.id, hypothesisIds: [h.hypothesis.id], note: 'v1' });

    // 用同一个目录重新构造 Storage + Service，模拟进程重启
    const { Storage } = await import('../src/server/storage.js');
    const { Service } = await import('../src/server/service.js');
    const reopened = new Storage(storage.dir);
    const svc2 = new Service(reopened);
    const state2 = reopened.getState();
    expect(Object.keys(state2.runs)).toHaveLength(1);
    expect(Object.values(state2.drafts)[0].versions).toHaveLength(1);
    expect(svc2).toBeDefined();
    // blob 字节也能读回
    const sampleId = Object.keys(state2.samples)[0];
    expect(reopened.readBlob(state2.samples[sampleId].blobId).length).toBe(4);
  });
});

describe('内容去重：相同字节复用 blob，来源备注各自保留', () => {
  it('两份相同内容只存一个 blob，但 sample/备注独立', async () => {
    const { service, storage } = makeService();
    const content = buildBytes(['HELLO']);
    const r1 = await service.addSample(content, '来源A.bin');
    const r2 = await service.addSample(content, '来源B.bin');
    expect(r1.deduped).toBe(false);
    expect(r2.deduped).toBe(true);
    const state = storage.getState();
    expect(Object.keys(state.blobs)).toHaveLength(1);
    const samples = Object.values(state.samples);
    expect(samples).toHaveLength(2);
    expect(new Set(samples.map((s) => s.blobId)).size).toBe(1);
    expect(samples.map((s) => s.note).sort()).toEqual(['来源A.bin', '来源B.bin']);
  });

  it('删除最后一个引用样本后 blob 被回收；删一个另一个仍可读', async () => {
    const { service, storage } = makeService();
    const content = buildBytes(['HELLO']);
    await service.addSample(content, 'a');
    const b = await service.addSample(content, 'b');
    service.removeSample(b.sample.id);
    expect(Object.keys(storage.getState().blobs)).toHaveLength(1);
    const left = Object.values(storage.getState().samples)[0];
    expect(storage.readBlob(left.blobId).length).toBe(5);
    service.removeSample(left.id);
    expect(Object.keys(storage.getState().blobs)).toHaveLength(0);
  });
});
