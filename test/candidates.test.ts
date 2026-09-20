import { describe, it, expect } from 'vitest';
import { makeService, buildBytes, u16 } from './helpers.js';

// Sample container:
//  [0,1)  opcode (enum-ish integer) = 0x07 constant
//  [1,3)  payload length u16 LE, equals byte length of region [3, ...)
//  [3..)  payload
function makeSample(opcode: number, payload: string) {
  const bytes = buildBytes([opcode, u16(payload.length, 'le'), payload]);
  return bytes;
}

describe('候选关系：相关性、支持样本数、确认流程', () => {
  it('发现长度关系候选并标明支持样本数；未确认不会进入草案', async () => {
    const { service, storage } = makeService();
    await service.addSample(makeSample(0x07, 'ABCD'), 's1');
    await service.addSample(makeSample(0x07, 'XY'), 's2');

    // 先声明整数与负载区域
    const len = service.addHypothesis({
      label: 'len_int', start: 1, end: 3,
      spec: { kind: 'integer', endian: 'le', size: 2, signed: false },
    });
    const payload = service.addHypothesis({
      label: 'payload', start: 3, end: 7,
      spec: { kind: 'string', encoding: 'ascii', requireNullTerminator: false, allowPrintableOnly: true },
    });
    void len;

    // 第二个样本的 payload 区间 [3,7) 越界（只有 5 字节）——整数候选只在能读到值的样本上统计
    const candidates = service.rerunDiscovery();
    const lengthCands = candidates.filter((c) => c.kind === 'length_relation');
    // s2 长度为 5，区间 [3,7) 越界，但基于“到文件尾剩余长度”的候选仍然成立
    const eofCand = lengthCands.find((c) => c.description.includes('文件尾'));
    expect(eofCand).toBeDefined();
    expect(eofCand!.supportCount).toBe(2);
    expect(eofCand!.totalSamples).toBe(2);
    expect(eofCand!.status).toBe('proposed');

    // 常量候选（opcode 0x07 跨样本恒定）
    const opcode = service.addHypothesis({
      label: 'opcode_int', start: 0, end: 1,
      spec: { kind: 'integer', endian: 'le', size: 1, signed: false },
    });
    const afterOpcode = service.rerunDiscovery();
    const constCand = afterOpcode.find((c) => c.kind === 'constant');
    expect(constCand).toBeDefined();
    expect(constCand!.supportCount).toBe(2);

    // 候选没有进入任何草案字段
    const state = storage.getState();
    expect(Object.values(state.drafts)).toHaveLength(0);
    void payload;
    void opcode;
  });

  it('确认候选会提升为新假设并立即验证；草案可使用该假设发布', async () => {
    const { service, storage } = makeService();
    await service.addSample(makeSample(0x07, 'ABCD'), 's1');
    await service.addSample(makeSample(0x07, 'EFGH'), 's2');
    service.addHypothesis({
      label: 'payload', start: 3, end: 7,
      spec: { kind: 'string', encoding: 'ascii', requireNullTerminator: false, allowPrintableOnly: true },
    });
    service.addHypothesis({
      label: 'len_int', start: 1, end: 3,
      spec: { kind: 'integer', endian: 'le', size: 2, signed: false },
    });
    const candidates = service.rerunDiscovery();
    const regionLenCand = candidates.find(
      (c) => c.kind === 'length_relation' && c.spec.kind === 'length' && c.spec.target.kind === 'region',
    );
    expect(regionLenCand).toBeDefined();
    expect(regionLenCand!.supportCount).toBe(2);

    const confirmed = service.confirmCandidate(regionLenCand!.id);
    expect(confirmed.hypothesis.spec.kind).toBe('length');
    expect(confirmed.run.hits).toBe(2);
    expect(confirmed.candidate.status).toBe('confirmed');
    expect(confirmed.hypothesis.fromCandidateId).toBe(regionLenCand!.id);

    // 新假设与原整数假设重叠 [1,3)，发布草案需裁决；两者在同一区间是不同解释
    const draft = service.createDraft('framed');
    const hypIds = Object.keys(storage.getState().hypotheses);
    expect(() => service.publishDraft({ draftId: draft.id, hypothesisIds: hypIds, note: 'v1' })).toThrow(/重叠/);
  });

  it('部分支持的候选必须显示支持样本数，且不会在全量条件不满足时被虚构', async () => {
    const { service } = makeService();
    // s1: len=4 payload 4; s2: len=9 payload 2 -> 长度关系不成立（但整数仍可读）
    await service.addSample(makeSample(0x07, 'ABCD'), 's1');
    await service.addSample(buildBytes([0x07, u16(9, 'le'), 'XY']), 's2');
    service.addHypothesis({
      label: 'payload', start: 3, end: 7,
      spec: { kind: 'string', encoding: 'ascii', requireNullTerminator: false, allowPrintableOnly: true },
    });
    service.addHypothesis({
      label: 'len_int', start: 1, end: 3,
      spec: { kind: 'integer', endian: 'le', size: 2, signed: false },
    });
    const candidates = service.rerunDiscovery();
    const regionLength = candidates.filter(
      (c) => c.kind === 'length_relation' && c.spec.kind === 'length' && c.spec.target.kind === 'region',
    );
    expect(regionLength).toHaveLength(0);
  });

  it('校验关系候选：sum8 跨样本一致时被提出', async () => {
    const { service } = makeService();
    // payload 'AB' = 0x41+0x42 = 0x83
    const mk = (p: number[]) => buildBytes([p, 'AB']);
    await service.addSample(mk([0x83]), 's1');
    await service.addSample(mk([0x83]), 's2');
    service.addHypothesis({
      label: 'payload', start: 1, end: 3,
      spec: { kind: 'string', encoding: 'ascii', requireNullTerminator: false, allowPrintableOnly: true },
    });
    service.addHypothesis({
      label: 'chk_int', start: 0, end: 1,
      spec: { kind: 'integer', endian: 'le', size: 1, signed: false },
    });
    const candidates = service.rerunDiscovery();
    const chk = candidates.find((c) => c.kind === 'checksum_relation');
    expect(chk).toBeDefined();
    expect(chk!.description).toContain('sum8');
    expect(chk!.supportCount).toBe(2);
  });
});

describe('候选支持数随样本变化重算（不伪造全量支持）', () => {
  it('新反例样本加入后，原候选支持数下降/失效，且不改变已确认假设的历史', async () => {
    const { service, storage } = makeService();
    await service.addSample(makeSample(0x07, 'ABCD'), 'good1');
    service.addHypothesis({
      label: 'payload', start: 3, end: 7,
      spec: { kind: 'string', encoding: 'ascii', requireNullTerminator: false, allowPrintableOnly: true },
    });
    service.addHypothesis({
      label: 'len_int', start: 1, end: 3,
      spec: { kind: 'integer', endian: 'le', size: 2, signed: false },
    });
    let candidates = service.rerunDiscovery();
    let region = candidates.find(
      (c) => c.kind === 'length_relation' && c.spec.kind === 'length' && c.spec.target.kind === 'region',
    );
    expect(region!.supportCount).toBe(1);
    expect(region!.totalSamples).toBe(1);

    // 确认后再追加一个长度不匹配的样本
    const confirmed = service.confirmCandidate(region!.id);
    expect(confirmed.hypothesis.runIds.length).toBe(1);

    await service.addSample(buildBytes([0x07, u16(99, 'le'), 'XYZW']), 'badlen');
    const state = storage.getState();
    const refreshed = Object.values(state.candidates).find(
      (c) => c.id === region!.id,
    )!;
    // 已确认候选保持 confirmed；其派生假设新增了一次 run（历史不改写）
    expect(refreshed.status).toBe('confirmed');
    const promotedHyp = state.hypotheses[confirmed.hypothesis.id];
    expect(promotedHyp.runIds.length).toBe(2);
    const secondRun = state.runs[promotedHyp.runIds[1]];
    expect(secondRun.hits).toBe(1);
    expect(secondRun.counterexamples).toBe(1);
  });

  it('未确认候选在关系完全失效后自动失效，不会被确认进草案', async () => {
    const { service, storage } = makeService();
    await service.addSample(makeSample(0x07, 'ABCD'), 'g1');
    service.addHypothesis({
      label: 'payload', start: 3, end: 7,
      spec: { kind: 'string', encoding: 'ascii', requireNullTerminator: false, allowPrintableOnly: true },
    });
    service.addHypothesis({
      label: 'len_int', start: 1, end: 3,
      spec: { kind: 'integer', endian: 'le', size: 2, signed: false },
    });
    const before = service.rerunDiscovery().filter((c) => c.kind === 'length_relation' && c.spec.kind === 'length' && c.spec.target.kind === 'region');
    expect(before.length).toBe(1);

    // 再来两个坏样本，支持数变成 1/3，低于“至少两个”门槛 -> 候选失效
    await service.addSample(buildBytes([0x07, u16(99, 'le'), 'XXXX']), 'b1');
    await service.addSample(buildBytes([0x07, u16(98, 'le'), 'YYYY']), 'b2');
    const after = Object.values(storage.getState().candidates).filter(
      (c) => c.kind === 'length_relation' && c.status === 'proposed',
    );
    expect(after.find((c) => c.signature.includes('region'))).toBeUndefined();
  });
});
