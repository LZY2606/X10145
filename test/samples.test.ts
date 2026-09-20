import { describe, expect, it } from 'vitest';
import { harness } from './helpers';
import { hypothesisStatus } from '../src/shared/semantics';
import { addSample } from '../src/shared/store';

describe('追加样本与历史不可变', () => {
  it('新样本追加新验证结果，旧记录保留且提出时样本集合快照不变', () => {
    const h = harness();
    h.add('a', [0x01, 0x00]);
    const created = h.hyp(h.state, h.blobs, {
      name: 'x',
      type: 'integer',
      range: { start: 0, end: 2 },
      config: { type: 'integer', intKind: 'u16', endian: 'little' },
    });
    expect(created.hypothesis.proposedWithSampleIds).toHaveLength(1);
    const firstRun = h.state.verifications.filter((v) => v.hypothesisId === created.hypothesis.id);
    expect(firstRun.at(-1)!.sampleIds).toHaveLength(1);

    h.add('b', [0x02, 0x00]);
    const runs = h.state.verifications.filter((v) => v.hypothesisId === created.hypothesis.id);
    // 旧结果未被改写，新增了一次包含两份样本的验证
    expect(runs).toHaveLength(2);
    expect(runs[0].sampleIds).toHaveLength(1);
    expect(runs[1].sampleIds).toHaveLength(2);
    // 提出时快照依然是 1
    expect(h.state.hypotheses[created.hypothesis.id].proposedWithSampleIds).toHaveLength(1);
    expect(hypothesisStatus(h.state, created.hypothesis.id)).toBe('hit');
  });

  it('新样本带来反例时历史命中记录仍可追溯，假设不会被改写为从未成立', () => {
    const h = harness();
    h.add('good', [0x02, 0x00, 0xaa, 0xbb]);
    const created = h.hyp(h.state, h.blobs, {
      name: 'len',
      type: 'length',
      range: { start: 0, end: 2 },
      config: {
        type: 'length',
        intKind: 'u16',
        endian: 'little',
        unit: 1,
        region: { kind: 'fixed', start: 2, end: -1 },
      },
    });
    const run1 = h.state.verifications.filter((v) => v.hypothesisId === created.hypothesis.id).at(-1)!;
    expect(run1.results[0].status).toBe('hit');

    // 第二份样本声称长度 9，但只有 1 个剩余字节
    h.add('bad', [0x09, 0x00, 0]);
    const runs = h.state.verifications.filter((v) => v.hypothesisId === created.hypothesis.id);
    expect(runs).toHaveLength(2);
    expect(runs[0].results[0].status).toBe('hit');
    expect(runs[1].results[0].status).toBe('hit');
    expect(runs[1].results[1].status).toBe('counterexample');
    expect(hypothesisStatus(h.state, created.hypothesis.id)).toBe('counterexample');
  });
});

describe('内容去重', () => {
  it('相同内容样本复用 blob，但来源备注各自保留', () => {
    const h = harness();
    const first = addSample(
      h.state,
      { name: 'from-device-A', note: '设备 A 抓取', bytes: Uint8Array.from([9, 8, 7]) },
      h.blobs,
    );
    const second = addSample(
      h.state,
      { name: 'from-device-B', note: '设备 B 抓取', bytes: Uint8Array.from([9, 8, 7]) },
      h.blobs,
    );
    expect(first.reusedBlob).toBe(false);
    expect(second.reusedBlob).toBe(true);
    expect(first.sample.blobSha256).toBe(second.sample.blobSha256);
    expect(h.state.samples[first.sample.id].note).toBe('设备 A 抓取');
    expect(h.state.samples[second.sample.id].note).toBe('设备 B 抓取');
    expect(Object.keys(h.state.blobs)).toHaveLength(1);
    expect(h.state.sampleOrder).toHaveLength(2);
  });
});
