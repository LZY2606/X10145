import { describe, it, expect } from 'vitest';
import { makeService, buildBytes } from './helpers.js';
import {
  buildVersion,
  buildStableExport,
  exportCanonicalJson,
  stableStringify,
} from '../src/core/draft.js';

describe('半开区间语义 [start,end)', () => {
  it('零长度区间 start==end 合法但非空解码失败；end 不包含字节', async () => {
    const { service } = makeService();
    await service.addSample(buildBytes(['AB']), 's');
    // 字符串零长度 -> 服务拒绝
    expect(() =>
      service.addHypothesis({
        label: 'empty', start: 0, end: 0,
        spec: { kind: 'string', encoding: 'ascii', requireNullTerminator: false, allowPrintableOnly: false },
      }),
    ).toThrow(/空/);
    // 半开：[0,1) 只覆盖第一个字节 'A'
    const h = service.addHypothesis({
      label: 'a', start: 0, end: 1,
      spec: { kind: 'string', encoding: 'ascii', requireNullTerminator: false, allowPrintableOnly: true },
    });
    expect(h.run.results[0].verdict).toBe('hit');
    expect(h.run.results[0].value).toBe('"A"');
  });

  it('end 恰好等于样本长度是命中；end 多 1 字节即越界', async () => {
    const { service } = makeService();
    await service.addSample(buildBytes(['AB']), 's');
    const fit = service.addHypothesis({
      label: 'fit', start: 0, end: 2,
      spec: { kind: 'string', encoding: 'ascii', requireNullTerminator: false, allowPrintableOnly: true },
    });
    expect(fit.run.results[0].verdict).toBe('hit');
    const over = service.addHypothesis({
      label: 'over', start: 0, end: 3,
      spec: { kind: 'string', encoding: 'ascii', requireNullTerminator: false, allowPrintableOnly: true },
    });
    expect(over.run.results[0].verdict).toBe('out_of_bounds');
    expect(over.run.results[0].atOffset).toBe(2);
  });

  it('非法区间（负数/反转）在声明时被拒绝', async () => {
    const { service } = makeService();
    await service.addSample(buildBytes(['AB']), 's');
    expect(() =>
      service.addHypothesis({ label: 'bad', start: 2, end: 1, spec: { kind: 'integer', endian: 'le', size: 1, signed: false } }),
    ).toThrow(/半开/);
  });
});

describe('稳定导出：键排序、跨运行确定性、哈希稳定', () => {
  const mkState = (ids: string[]) => {
    const ordered = [...ids].sort();
    return {
      hypotheses: Object.fromEntries(
        ordered.map((id, i) => [
          id,
          {
            id,
            label: 'same-label',
            start: i,
            end: i + 1,
            createdAt: '2026-01-01T00:00:00.000Z',
            proposedWithSamples: [],
            runIds: [],
            spec: { kind: 'integer', endian: 'le', size: 1, signed: false },
          },
        ]),
      ),
      adjudications: {},
    };
  };

  const emptyDraft = {
    id: 'd1', name: 'F', createdAt: 't', updatedAt: 't', publishedVersion: null as number | null, versions: [],
  };

  it('字段选择顺序不影响导出字节', () => {
    const a = buildVersion({
      draft: structuredClone(emptyDraft),
      selectedHypothesisIds: ['x', 'y'],
      state: mkState(['x', 'y']) as never,
      note: 'v1',
      now: '2026-03-01T00:00:00.000Z',
    });
    const b = buildVersion({
      draft: structuredClone(emptyDraft),
      selectedHypothesisIds: ['y', 'x'],
      state: mkState(['y', 'x']) as never,
      note: 'v1',
      now: '2026-03-01T00:00:00.000Z',
    });
    expect(stableStringify(buildStableExport(a.draft))).toBe(stableStringify(buildStableExport(b.draft)));
    expect(exportCanonicalJson(a.draft)).toBe(exportCanonicalJson(b.draft));
  });

  it('canonicalHash 是 sha256 hex，且内容变化时哈希变化', () => {
    const a = buildVersion({
      draft: structuredClone(emptyDraft),
      selectedHypothesisIds: ['x'],
      state: mkState(['x']) as never,
      note: 'v1',
      now: '2026-03-01T00:00:00.000Z',
      hasher: (s) => {
        // Node crypto available in tests
        const { createHash } = require('node:crypto');
        return createHash('sha256').update(s).digest('hex');
      },
    });
    expect(a.version.canonicalHash).toMatch(/^[a-f0-9]{64}$/);
    const b = buildVersion({
      draft: structuredClone(emptyDraft),
      selectedHypothesisIds: ['x'],
      state: mkState(['x']) as never,
      note: 'different note',
      now: '2026-03-01T00:00:00.000Z',
      hasher: (s) => require('node:crypto').createHash('sha256').update(s).digest('hex'),
    });
    expect(b.version.canonicalHash).not.toBe(a.version.canonicalHash);
  });
});
