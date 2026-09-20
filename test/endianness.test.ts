import { describe, expect, it } from 'vitest';
import { harness } from './helpers';
import { hypothesisStatus, latestVerification } from '../src/shared/semantics';

describe('端序与整数解码', () => {
  it('同一份 16 位字段在小端/大端假设下分别命中或产生反例', () => {
    const h = harness();
    h.add('a', [0x34, 0x12, 0x00]);
    h.add('b', [0x78, 0x56, 0x00]);

    const le = h.hyp(h.state, h.blobs, {
      name: 'v_le',
      type: 'integer',
      range: { start: 0, end: 2 },
      config: { type: 'integer', intKind: 'u16', endian: 'little' },
    });
    const be = h.hyp(h.state, h.blobs, {
      name: 'v_be',
      type: 'integer',
      range: { start: 0, end: 2 },
      config: { type: 'integer', intKind: 'u16', endian: 'big' },
    });

    expect(hypothesisStatus(h.state, le.hypothesis.id)).toBe('hit');
    expect(hypothesisStatus(h.state, be.hypothesis.id)).toBe('hit');

    const leVerification = latestVerification(h.state, le.hypothesis.id)!;
    expect(leVerification.results.map((r) => r.observed)).toEqual(['4660', '22136']);
    const beVerification = latestVerification(h.state, be.hypothesis.id)!;
    expect(beVerification.results.map((r) => r.observed)).toEqual(['13330', '30806']);
  });

  it('有符号 24 位负数可正确解码', () => {
    const h = harness();
    h.add('signed', [0xff, 0xff, 0xff]);
    const result = h.hyp(h.state, h.blobs, {
      name: 's24',
      type: 'integer',
      range: { start: 0, end: 3 },
      config: { type: 'integer', intKind: 'i24', endian: 'little' },
    });
    expect(latestVerification(h.state, result.hypothesis.id)!.results[0].observed).toBe('-1');
  });
});
