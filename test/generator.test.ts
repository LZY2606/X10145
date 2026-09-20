import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { makeService, buildBytes, u16, u32 } from './helpers.js';
import { generateParser } from '../src/core/generator.js';
import { exportCanonicalJson, buildStableExport } from '../src/core/draft.js';
import { parseWithDraft, type ParseError, type ParseSuccess } from '../src/core/parserEngine.js';

const shared = makeService();

let parserPath = '';
let draftId = '';

beforeAll(async () => {
  const { service } = shared;
  const fixed = buildBytes([u16(0xf00d, 'le'), u16(3, 'le'), 'DATA']);
  await service.addSample(fixed, 's1');
  const magic = service.addHypothesis({
    label: 'magic', start: 0, end: 2,
    spec: { kind: 'enum', endian: 'le', size: 2, signed: false, members: [{ name: 'MAGIC', value: 0xf00d }] },
  });
  const table = service.addHypothesis({
    label: 'table', start: 2, end: 4,
    spec: { kind: 'offset_table', endian: 'le', entrySize: 2, count: 1, base: { kind: 'field_start' }, unit: 2 },
  });
  const payload = service.addHypothesis({
    label: 'payload', start: 4, end: 8,
    spec: { kind: 'string', encoding: 'ascii', requireNullTerminator: false, allowPrintableOnly: true },
  });
  const draft = service.createDraft('container');
  const published = service.publishDraft({
    draftId: draft.id,
    hypothesisIds: [magic.hypothesis.id, table.hypothesis.id, payload.hypothesis.id],
    note: 'v1',
  });
  draftId = published.id;

  const dir = mkdtempSync(join(tmpdir(), 'gen-parser-'));
  parserPath = join(dir, 'parser-generated.mjs');
  writeFileSync(parserPath, generateParser(published));
});

async function loadParser() {
  const mod = await import(pathToFileURL(parserPath).href + `?v=${Math.random()}`);
  return (input: Parameters<typeof mod.parse>[0]) => mod.parse(input) as ParseSuccess | ParseError;
}

describe('生成器：只按草案解析，错误返回路径与偏移', () => {
  it('合法输入解析出全部字段并给出消耗字节数', async () => {
    const parse = await loadParser();
    const result = parse(buildBytes([u16(0xf00d, 'le'), u16(3, 'le'), 'DATA']));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.magic).toMatchObject({ type: 'enum', name: 'MAGIC' });
      expect(result.value.table).toMatchObject({ type: 'offset_table', targets: [8] });
      expect(result.value.payload).toMatchObject({ type: 'string', value: 'DATA' });
      expect(result.bytesConsumed).toBe(8);
    }
  });

  it('截断输入：返回 $.payload 与越界偏移，不抛异常', async () => {
    const parse = await loadParser();
    // 表项指向 4（2 + 1*2），表本身合法；但 payload [4,8) 缺失
    const result = parse(buildBytes([u16(0xf00d, 'le'), u16(1, 'le')]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.path).toBe('$.payload');
      expect(result.offset).toBe(4);
      expect(result.code).toBe('out_of_bounds');
    }
  });

  it('非法枚举：路径 $.magic、偏移 0、code=invalid_enum', async () => {
    const parse = await loadParser();
    const result = parse(buildBytes([u16(0x1234, 'le'), u16(3, 'le'), 'DATA']));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.path).toBe('$.magic');
      expect(result.offset).toBe(0);
      expect(result.code).toBe('invalid_enum');
    }
  });

  it('偏移表项指向文件外：路径带 [0] 索引', async () => {
    const parse = await loadParser();
    const result = parse(buildBytes([u16(0xf00d, 'le'), u16(0x0040, 'le'), 'DATA']));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.path).toBe('$.table[0]');
      expect(result.code).toBe('out_of_bounds');
      expect(result.offset).toBeGreaterThanOrEqual(0);
    }
  });

  it('32 位巨大偏移越界而非崩溃（直接引擎）', () => {
    const draft = {
      format: 'binary-format-inference-bench/draft',
      fields: [
        {
          hypothesisId: 'x', label: 'off32', start: 2, end: 6,
          spec: { kind: 'offset_table', endian: 'le', entrySize: 4, count: 1, base: { kind: 'start' }, unit: 1 },
        },
      ],
    };
    const result = parseWithDraft(buildBytes([u16(0xf00d, 'le'), u32(0xffffffff, 'le')]), draft as never);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.path).toBe('$.off32[0]');
      expect(result.code).toBe('out_of_bounds');
    }
  });

  it('长度字段不一致时报告偏移与路径（直接引擎）', () => {
    const draft = {
      format: 'binary-format-inference-bench/draft',
      fields: [
        {
          hypothesisId: 'x', label: 'file_len', start: 0, end: 2,
          spec: { kind: 'length', endian: 'le', size: 2, signed: false, unit: 1, target: { kind: 'file' } },
        },
      ],
    };
    const result = parseWithDraft(buildBytes([u16(99, 'le'), 'AB']), draft as never);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.path).toBe('$.file_len');
      expect(result.offset).toBe(0);
      expect(result.code).toBe('out_of_bounds');
    }
  });

  it('稳定导出 JSON 可被同一引擎直接消费，且哈希为真实 sha256', async () => {
    const { storage } = shared;
    const draft = storage.getState().drafts[draftId];
    const canonical = exportCanonicalJson(draft);
    const reparsed = JSON.parse(canonical);
    const result = parseWithDraft(buildBytes([u16(0xf00d, 'le'), u16(3, 'le'), 'DATA']), reparsed);
    expect(result.ok).toBe(true);
    expect(buildStableExport(draft).canonicalHash).toMatch(/^[a-f0-9]{64}$/);
    // 重复导出字节一致
    expect(exportCanonicalJson(draft)).toBe(canonical);
  });
});

describe('生成器：校验字段与多段范围', () => {
  it('校验范围越界返回 out_of_bounds 而非崩溃', () => {
    const draft = {
      format: 'binary-format-inference-bench/draft',
      fields: [
        {
          hypothesisId: 'c', label: 'chk', start: 0, end: 1,
          spec: {
            kind: 'checksum', endian: 'le', size: 1, algorithm: 'sum8',
            ranges: [{ kind: 'absolute', start: 1, end: 9 }],
          },
        },
      ],
    };
    const result = parseWithDraft(Uint8Array.of(0x44, 0x41, 0x42), draft as never);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.path).toBe('$.chk');
      expect(result.code).toBe('out_of_bounds');
    }
  });

  it('多段（不连续）校验范围只覆盖声明字节：字段+尾部负载', () => {
    // 对 [0]=opcode 和 [2..4)=payload 做 sum8，跳过中间 [1] 校验字段本身
    const opcode = 0x01;
    const payload = Uint8Array.of(0x41, 0x42); // 'AB' printable
    const chk = (opcode + 0x41 + 0x42) & 0xff;
    const draft = {
      format: 'binary-format-inference-bench/draft',
      fields: [
        { hypothesisId: 'op', label: 'opcode', start: 0, end: 1, spec: { kind: 'integer', endian: 'le', size: 1, signed: false } },
        { hypothesisId: 'ch', label: 'chk', start: 1, end: 2, spec: {
          kind: 'checksum', endian: 'le', size: 1, algorithm: 'sum8',
          ranges: [{ kind: 'absolute', start: 0, end: 1 }, { kind: 'absolute', start: 2, end: 4 }],
        } },
        { hypothesisId: 'pl', label: 'payload', start: 2, end: 4, spec: { kind: 'string', encoding: 'ascii', requireNullTerminator: false, allowPrintableOnly: true } },
      ],
    };
    const good = Uint8Array.of(opcode, chk, ...payload);
    const okResult = parseWithDraft(good, draft as never);
    expect(okResult.ok).toBe(true);
    const bad = Uint8Array.of(opcode, (chk + 1) & 0xff, ...payload);
    const badResult = parseWithDraft(bad, draft as never);
    expect(badResult.ok).toBe(false);
    if (!badResult.ok) expect(badResult.path).toBe('$.chk');
  });
});
