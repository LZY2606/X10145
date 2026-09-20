import { describe, it, expect } from 'vitest';
import { makeService, buildBytes } from './helpers.js';

describe('校验字段：sum8/xor8/sum16 与解析器行为一致', () => {
  const sum8 = (b: number[]) => b.reduce((a, x) => (a + x) & 0xff, 0);
  const xor8 = (b: number[]) => b.reduce((a, x) => a ^ x, 0);
  const sum16le = (b: number[]) => {
    let v = 0;
    for (let i = 0; i < b.length; i += 2) v = (v + b[i] + ((b[i + 1] ?? 0) << 8)) & 0xffff;
    return v >>> 0;
  };

  it('sum8 命中与反例都给出字段偏移', async () => {
    const { service } = makeService();
    const payload = [...Buffer.from('OK!', 'ascii')];
    const chk = sum8(payload);
    const good = buildBytes([[chk], payload]);
    const bad = buildBytes([[(chk + 1) & 0xff], payload]);
    await service.addSample(good, 'good');
    await service.addSample(bad, 'bad');
    const h = service.addHypothesis({
      label: 'chk', start: 0, end: 1,
      spec: { kind: 'checksum', endian: 'le', size: 1, algorithm: 'sum8', ranges: [{ kind: 'absolute', start: 1, end: 4 }] },
    });
    expect(h.run.hits).toBe(1);
    expect(h.run.counterexamples).toBe(1);
    const badResult = h.run.results.find((r) => r.verdict === 'counterexample')!;
    expect(badResult.atOffset).toBe(0);
    expect(badResult.detail).toMatch(/sum8/);
  });

  it('xor8 命中', async () => {
    const { service } = makeService();
    const payload = [0x10, 0x20, 0x30];
    await service.addSample(buildBytes([[xor8(payload)], payload]), 'x');
    const h = service.addHypothesis({
      label: 'chk', start: 0, end: 1,
      spec: { kind: 'checksum', endian: 'le', size: 1, algorithm: 'xor8', ranges: [{ kind: 'absolute', start: 1, end: 4 }] },
    });
    expect(h.run.hits).toBe(1);
  });

  it('sum16 小端字累加，命中', async () => {
    const { service } = makeService();
    const payload = [0x01, 0x02, 0x03, 0x04, 0x05]; // odd length -> trailing pad
    const value = sum16le(payload);
    await service.addSample(buildBytes([[value & 0xff, (value >> 8) & 0xff], payload]), 'x');
    const h = service.addHypothesis({
      label: 'chk16', start: 0, end: 2,
      spec: { kind: 'checksum', endian: 'le', size: 2, algorithm: 'sum16', ranges: [{ kind: 'absolute', start: 2, end: 7 }] },
    });
    expect(h.run.hits).toBe(1);
  });

  it('校验区间引用另一区域', async () => {
    const { service } = makeService();
    const payload = [...Buffer.from('ABCD', 'ascii')];
    await service.addSample(buildBytes([[sum8(payload)], payload]), 'x');
    const region = service.addHypothesis({
      label: 'data', start: 1, end: 5,
      spec: { kind: 'string', encoding: 'ascii', requireNullTerminator: false, allowPrintableOnly: true },
    });
    const h = service.addHypothesis({
      label: 'chk', start: 0, end: 1,
      spec: { kind: 'checksum', endian: 'le', size: 1, algorithm: 'sum8', ranges: [{ kind: 'region', hypothesisId: region.hypothesis.id }] },
    });
    expect(h.run.hits).toBe(1);
  });

  it('校验覆盖区间越界 -> out_of_bounds', async () => {
    const { service } = makeService();
    await service.addSample(buildBytes([[0x44], 'AB']), 'short');
    const h = service.addHypothesis({
      label: 'chk', start: 0, end: 1,
      spec: { kind: 'checksum', endian: 'le', size: 1, algorithm: 'sum8', ranges: [{ kind: 'absolute', start: 1, end: 9 }] },
    });
    expect(h.run.results[0].verdict).toBe('out_of_bounds');
  });
});
