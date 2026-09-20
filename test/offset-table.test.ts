import { describe, it, expect } from 'vitest';
import { makeService, buildBytes, u16, u32 } from './helpers.js';

// Layout for the "happy" samples:
//  0..2  magic
//  2..4  u16 offset table with ONE entry: relative to table start (offset 2), unit 2
//  4..8  payload "DATA"
// Table raw value = (8 - 2)/2 = 3
function sample(extra = 0) {
  return buildBytes(['MG', u16(3, 'le'), 'DATA', extra > 0 ? new Array(extra).fill(0) : []]);
}

describe('偏移表：端序、相对基准、单位、越界', () => {
  it('相对偏移（基准=表起点，单位×2）正确解析到绝对地址', async () => {
    const { service } = makeService();
    await service.addSample(sample(), 'a');
    const hyp = service.addHypothesis({
      label: 'offsets',
      start: 2, end: 4,
      spec: {
        kind: 'offset_table', endian: 'le', entrySize: 2, count: 1,
        base: { kind: 'field_start' }, unit: 2,
      },
    });
    expect(hyp.run.results[0].verdict).toBe('hit');
    expect(hyp.run.results[0].numeric).toEqual([8]);
  });

  it('错误端序导致目标落在中间字节 -> 反例/越界并给出条目偏移', async () => {
    const { service } = makeService();
    await service.addSample(sample(), 'a');
    // value 3 LE bytes are [03,00]; reading BE gives 0x0300 = 768 -> out of bounds
    const hyp = service.addHypothesis({
      label: 'offsets_be',
      start: 2, end: 4,
      spec: { kind: 'offset_table', endian: 'be', entrySize: 2, count: 1, base: { kind: 'field_start' }, unit: 2 },
    });
    const r = hyp.run.results[0];
    expect(['counterexample', 'out_of_bounds']).toContain(r.verdict);
    expect(r.atOffset).toBe(2);
    expect(r.detail).toMatch(/out of bounds|越界/);
  });

  it('大端样本在大端声明下命中', async () => {
    const { service } = makeService();
    const bytes = buildBytes(['MG', u16(3, 'be'), 'DATA']);
    await service.addSample(bytes, 'be-sample');
    const hyp = service.addHypothesis({
      label: 'offsets', start: 2, end: 4,
      spec: { kind: 'offset_table', endian: 'be', entrySize: 2, count: 1, base: { kind: 'field_start' }, unit: 2 },
    });
    expect(hyp.run.results[0].verdict).toBe('hit');
  });

  it('区间本身超出样本长度 -> out_of_bounds', async () => {
    const { service } = makeService();
    await service.addSample(buildBytes(['MG', u16(3, 'le')]), 'short');
    const hyp = service.addHypothesis({
      label: 'offsets', start: 2, end: 6,
      spec: { kind: 'offset_table', endian: 'le', entrySize: 2, count: 2, base: { kind: 'start' }, unit: 1 },
    });
    expect(hyp.run.results[0].verdict).toBe('out_of_bounds');
    expect(hyp.run.results[0].atOffset).toBe(4);
  });

  it('巨大偏移值触发溢出/越界判定', async () => {
    const { service } = makeService();
    await service.addSample(buildBytes(['MG', u32(0xffffffff), 'DATA']), 'huge');
    const hyp = service.addHypothesis({
      label: 'offsets32', start: 2, end: 6,
      spec: { kind: 'offset_table', endian: 'le', entrySize: 4, count: 1, base: { kind: 'start' }, unit: 1 },
    });
    const r = hyp.run.results[0];
    expect(r.verdict).not.toBe('hit');
    expect(r.atOffset).toBeDefined();
  });

  it('基准点引用另一区域起点（相对偏移跨区域）', async () => {
    const { service } = makeService();
    // header region at [0,4); table at [4,6) holds u16 distance from header start to payload at 8
    // distance = 8, unit 1
    const bytes = buildBytes([u32(0x11223344, 'le'), u16(8, 'le'), 'DATA']);
    await service.addSample(bytes, 'x');
    const header = service.addHypothesis({
      label: 'header', start: 0, end: 4,
      spec: { kind: 'integer', endian: 'le', size: 4, signed: false },
    });
    const table = service.addHypothesis({
      label: 'rel_table', start: 4, end: 6,
      spec: {
        kind: 'offset_table', endian: 'le', entrySize: 2, count: 1,
        base: { kind: 'region', hypothesisId: header.hypothesis.id }, unit: 1,
      },
    });
    expect(table.run.results[0].verdict).toBe('hit');
    expect(table.run.results[0].numeric).toEqual([8]);
  });
});
