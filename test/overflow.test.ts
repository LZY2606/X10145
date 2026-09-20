import { describe, expect, it } from 'vitest';
import { harness } from './helpers';
import { scaleValue } from '../src/shared/semantics';

describe('整数溢出与越界', () => {
  it('scaleValue 对超大乘积抛出溢出错误', () => {
    expect(() => scaleValue(1n << 50n, 4)).toThrow(/溢出|overflows/);
    expect(() => scaleValue(-5n, 1)).toThrow(/negative/);
  });

  it('长度字段声称巨大区域时是反例而不是崩溃', () => {
    const h = harness();
    h.add('tiny', [0x05, 0x00, 0x00, 0x00, 0xaa]);
    const result = h.hyp(h.state, h.blobs, {
      name: 'huge_len',
      type: 'length',
      range: { start: 0, end: 4 },
      config: {
        type: 'length',
        intKind: 'u32',
        endian: 'little',
        unit: 1,
        region: { kind: 'fixed', start: 4, end: -1 },
      },
    });
    const verification = h.state.verifications.filter((v) => v.hypothesisId === result.hypothesis.id).at(-1)!;
    expect(verification.results[0].status).toBe('counterexample');
    expect(verification.results[0].detail).toMatch(/长度|越界/);
  });

  it('区间本身超出样本长度直接判定反例', () => {
    const h = harness();
    h.add('three', [1, 2, 3]);
    const result = h.hyp(h.state, h.blobs, {
      name: 'oob',
      type: 'integer',
      range: { start: 2, end: 6 },
      config: { type: 'integer', intKind: 'u32', endian: 'little' },
    });
    const verification = h.state.verifications.filter((v) => v.hypothesisId === result.hypothesis.id).at(-1)!;
    expect(verification.results[0].status).toBe('counterexample');
    expect(verification.results[0].detail).toContain('超出样本长度');
  });

  it('u64 偏移乘单位超过安全范围返回反例', () => {
    const h = harness();
    const data = [0, 0, 0, 0, 0, 0, 0, 0xff, 1, 2];
    h.add('wide', data);
    const result = h.hyp(h.state, h.blobs, {
      name: 'wide_off',
      type: 'offset',
      range: { start: 0, end: 8 },
      config: {
        type: 'offset',
        intKind: 'u64',
        endian: 'big',
        base: 'document-start',
        unit: 8,
        anchorField: null,
      },
    });
    const verification = h.state.verifications.filter((v) => v.hypothesisId === result.hypothesis.id).at(-1)!;
    expect(verification.results[0].status).toBe('counterexample');
  });
});
