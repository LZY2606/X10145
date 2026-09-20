import { describe, expect, it } from 'vitest';
import { addHypothesis, addSample, publishDraft } from '../src/shared/store';
import { Repo } from '../src/server/repo';
import { makeTempPath } from './helpers';

describe('持久化', () => {
  it('重启后版本与验证历史仍然存在', () => {
    const path = makeTempPath();
    const repo = new Repo(path);
    const blobs = new Map();
    addSample(
      repo.state,
      { name: 's1', note: '来源X', bytes: Uint8Array.from([0x02, 0x00, 0xaa, 0xbb]) },
      blobs,
    );
    addHypothesis(repo.state, blobs, {
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
    publishDraft(repo.state, {
      hypothesisIds: Object.keys(repo.state.hypotheses),
      label: 'v1',
      notes: '',
      adjudications: [],
    });
    repo.save();

    const reopened = new Repo(path);
    expect(reopened.state.drafts).toHaveLength(1);
    expect(reopened.state.drafts[0].version).toBe(1);
    expect(reopened.state.verifications.length).toBeGreaterThan(0);
    expect(Object.values(reopened.state.samples)[0].note).toBe('来源X');
    expect(Object.keys(reopened.state.blobs)).toHaveLength(1);
  });

  it('状态文件缺失时以空状态启动而不是崩溃', () => {
    const repo = new Repo(makeTempPath());
    expect(repo.state.sampleOrder).toEqual([]);
  });
});
