import { describe, it, expect } from 'vitest';
import { readInt, resolveRelative } from '../src/core/binary.js';
import { makeService, buildBytes, u32 } from './helpers.js';

describe('整数读取：端序与溢出', () => {
  it('区分小端/大端 u32', () => {
    const le = Uint8Array.from([0x78, 0x56, 0x34, 0x12]);
    const be = Uint8Array.from([0x12, 0x34, 0x56, 0x78]);
    expect(readInt(le, 0, 4, 'le', false).value).toBe(0x12345678);
    expect(readInt(be, 0, 4, 'be', false).value).toBe(0x12345678);
  });

  it('有符号解释正确处理负数', () => {
    expect(readInt(Uint8Array.from([0xff]), 0, 1, 'le', true).value).toBe(-1);
    expect(readInt(Uint8Array.from([0xff, 0xff]), 0, 2, 'le', true).value).toBe(-1);
    expect(readInt(Uint8Array.from([0x80, 0x00]), 0, 2, 'be', true).value).toBe(-32768);
  });

  it('越界区间返回 out of bounds 而不是抛异常', () => {
    const buf = Uint8Array.of(1, 2);
    expect(readInt(buf, 1, 2, 'le', false)).toMatchObject({ ok: false, reason: 'out of bounds' });
    expect(readInt(buf, -1, 1, 'le', false).ok).toBe(false);
  });

  it('超过安全整数范围的 8 字节值报溢出', () => {
    const buf = new Uint8Array(8);
    buf[0] = 0x01;
    buf[7] = 0;
    // big-endian 0x0100000000000000 > MAX_SAFE_INTEGER
    expect(readInt(buf, 0, 8, 'be', false)).toMatchObject({ ok: false, reason: 'integer exceeds safe integer range' });
  });

  it('相对偏移解析检测乘法/加法溢出', () => {
    const huge = Number.MAX_SAFE_INTEGER;
    expect(resolveRelative(huge, 2, 0, 100).ok).toBe(false);
    expect(resolveRelative(huge, 1, 10, 100)).toMatchObject({ ok: false });
  });

  it('偏移越过缓冲区末尾判定越界并给出偏移', () => {
    const r = resolveRelative(50, 1, 0, 16);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.atOffset).toBe(16);
  });
});

describe('服务层：端序假设在样本上的命中与反例', () => {
  it('小端命中、大端反例（端序错误可被验证出来）', async () => {
    const { service } = makeService();
    const bytes = buildBytes([u32(0x42, 'le'), 'PAYL']);
    await service.addSample(bytes, 's1');
    const leHyp = service.addHypothesis({
      label: 'v_le', start: 0, end: 4,
      spec: { kind: 'integer', endian: 'le', size: 4, signed: false },
    });
    expect(leHyp.run.results[0].verdict).toBe('hit');
    expect(leHyp.run.results[0].numeric).toBe(0x42);

    // 枚举约束能把端序错误暴露成反例：同一段 LE 0x42 字节按 BE 读出 0x42000000
    const beEnum = service.addHypothesis({
      label: 'opcode_be', start: 0, end: 4,
      spec: { kind: 'enum', endian: 'be', size: 4, signed: false, members: [{ name: 'OP42', value: 0x42 }] },
    });
    expect(beEnum.run.results[0].verdict).toBe('counterexample');
    const leEnum = service.addHypothesis({
      label: 'opcode_le', start: 0, end: 4,
      spec: { kind: 'enum', endian: 'le', size: 4, signed: false, members: [{ name: 'OP42', value: 0x42 }] },
    });
    expect(leEnum.run.results[0].verdict).toBe('hit');
  });
});
