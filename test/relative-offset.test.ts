import { describe, expect, it } from 'vitest';
import { harness } from './helpers';
import { hypothesisStatus } from '../src/shared/semantics';

describe('相对偏移与单位', () => {
  it('field-start 基准 + 2 字节单位解析到另一字段开头时命中', () => {
    const h = harness();
    // 结构: [2字节锚点 anchor][2字节 off][payload ...]
    // 样本 a: anchor 在 0..2, off 在 2..4, payload 起始 6 => 相对 field-start 偏移 6/2=3
    h.add('a', [0x00, 0x01, 0x03, 0x00, 0xaa, 0xbb, 0x48, 0x65]);
    h.add('b', [0x00, 0x02, 0x02, 0x00, 0xcc, 0xdd, 0x4f, 0x6b]); // payload at 6 => 3? keep consistent
    const anchor = h.hyp(h.state, h.blobs, {
      name: 'anchor',
      type: 'integer',
      range: { start: 0, end: 2 },
      config: { type: 'integer', intKind: 'u16', endian: 'little' },
    });
    const payload = h.hyp(h.state, h.blobs, {
      name: 'payload',
      type: 'string',
      range: { start: 6, end: 8 },
      config: { type: 'string', encoding: 'ascii', trimNul: true },
    });
    const off = h.hyp(h.state, h.blobs, {
      name: 'off',
      type: 'offset',
      range: { start: 2, end: 4 },
      config: {
        type: 'offset',
        intKind: 'u16',
        endian: 'little',
        base: 'field-start',
        unit: 2,
        anchorField: anchor.hypothesis.id,
      },
    });
    expect(hypothesisStatus(h.state, off.hypothesis.id)).toBe('hit');
    expect(payload.hypothesis.range.start).toBe(6);
  });

  it('偏移越界成为反例并携带跳转偏移', () => {
    const h = harness();
    h.add('small', [0xff, 0xff, 0x00, 0x00]);
    const result = h.hyp(h.state, h.blobs, {
      name: 'bad_off',
      type: 'offset',
      range: { start: 0, end: 2 },
      config: {
        type: 'offset',
        intKind: 'u16',
        endian: 'little',
        base: 'document-start',
        unit: 1,
        anchorField: null,
      },
    });
    const verification = h.state.verifications.filter((v) => v.hypothesisId === result.hypothesis.id).at(-1)!;
    expect(verification.results[0].status).toBe('counterexample');
    expect(verification.results[0].jumpOffset).toBe(0);
    expect(verification.results[0].detail).toContain('越界');
  });

  it('document-end 基准的负向偏移（大值 u16）', () => {
    const h = harness();
    // 6 字节文档, u16=65534 = -2 -> 指向 4
    h.add('tail', [0xfe, 0xff, 0x00, 0x00, 0x41, 0x42]);
    const result = h.hyp(h.state, h.blobs, {
      name: 'tailoff',
      type: 'offset',
      range: { start: 0, end: 2 },
      config: {
        type: 'offset',
        intKind: 'u16',
        endian: 'little',
        base: 'document-end',
        unit: 1,
        anchorField: null,
      },
    });
    // 65534+6 溢出 -> counterexample（无符号字段不能为负）
    expect(h.state.verifications.filter((v) => v.hypothesisId === result.hypothesis.id).at(-1)!.results[0].status)
      .toBe('counterexample');
  });
});
