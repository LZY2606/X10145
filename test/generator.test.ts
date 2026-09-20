import { describe, expect, it } from 'vitest';
import { harness } from './helpers';
import { publishDraft, stableExportJson } from '../src/shared/store';
import { generateParserModule } from '../src/shared/generator';
import type { StableDraftExport } from '../src/shared/types';

async function loadParser(source: string): Promise<(bytes: Uint8Array) => any> {
  const url = 'data:text/javascript;base64,' + Buffer.from(source, 'utf-8').toString('base64');
  const module = await import(/* @vite-ignore */ url);
  return module.parse;
}

describe('生成器与稳定导出', () => {
  it('生成器按草案正确解析合法输入', async () => {
    const h = harness();
    h.add('a', [0x03, 0x00, 0x41, 0x42, 0x43]);
    const len = h.hyp(h.state, h.blobs, {
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
    const draft = publishDraft(h.state, {
      hypothesisIds: [len.hypothesis.id],
      label: '容器 v1',
      notes: '',
      adjudications: [],
    });
    const parse = await loadParser(generateParserModule(draft));
    const result = parse(Uint8Array.from([0x03, 0x00, 0x41, 0x42, 0x43]));
    expect(result.ok).toBe(true);
    expect(result.values['len']).toBe('3');
  });

  it('越界输入返回路径和偏移而不是抛出异常', async () => {
    const h = harness();
    h.add('a', [0x03, 0x00, 0x41, 0x42, 0x43]);
    const len = h.hyp(h.state, h.blobs, {
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
    const off = h.hyp(h.state, h.blobs, {
      name: 'ptr',
      type: 'offset',
      range: { start: 2, end: 4 },
      config: {
        type: 'offset',
        intKind: 'u16',
        endian: 'little',
        base: 'document-start',
        unit: 1,
        anchorField: null,
      },
    });
    const draft = publishDraft(h.state, {
      hypothesisIds: [len.hypothesis.id, off.hypothesis.id],
      label: '容器 v2',
      notes: '',
      adjudications: [
        {
          fieldAId: `field_${len.hypothesis.id}`,
          fieldBId: `field_${off.hypothesis.id}`,
          winnerFieldId: `field_${off.hypothesis.id}`,
        },
      ],
    });
    const parse = await loadParser(generateParserModule(draft));
    // ptr 区间 [2,4) 超出 3 字节输入
    const result = parse(Uint8Array.from([0x01, 0x00, 0xff]));
    expect(result.ok).toBe(false);
    expect(() => parse(Uint8Array.from([0x01, 0x00, 0xff]))).not.toThrow();
    const ptrError = result.errors.find((error: any) => error.path === '$.ptr');
    expect(ptrError).toBeTruthy();
    expect(ptrError.offset).toBe(2);
    expect(ptrError.message).toContain('越界');
  });

  it('稳定 JSON 导出可解析、含 schema 与版本，且键排序确定', () => {
    const h = harness();
    h.add('a', [1, 0, 65]);
    const created = h.hyp(h.state, h.blobs, {
      name: 'count',
      type: 'integer',
      range: { start: 0, end: 2 },
      config: { type: 'integer', intKind: 'u16', endian: 'little' },
    });
    publishDraft(h.state, {
      hypothesisIds: [created.hypothesis.id],
      label: 'stable',
      notes: 'n',
      adjudications: [],
    });
    const draft = h.state.drafts[0];
    const first = stableExportJson(draft);
    const second = stableExportJson(draft);
    expect(first).toBe(second);
    const parsed = JSON.parse(first) as StableDraftExport;
    expect(parsed.schema).toBe('binary-format-inference-bench/draft');
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.draft.version).toBe(1);
    expect(parsed.draft.fields[0].sourceHypothesisId).toBe(created.hypothesis.id);
  });
});

describe('生成器字段引用解析', () => {
  it('field-start 基准的相对偏移能在草案字段 id 带前缀时正常解析', async () => {
    const h = harness();
    // anchor(2) + off(2, value=2) + 2 gap + target at 6
    h.add('a', [0x01, 0x00, 0x02, 0x00, 0xaa, 0xbb, 0x41, 0x42]);
    const anchor = h.hyp(h.state, h.blobs, {
      name: 'anchor',
      type: 'integer',
      range: { start: 0, end: 2 },
      config: { type: 'integer', intKind: 'u16', endian: 'little' },
    });
    const off = h.hyp(h.state, h.blobs, {
      name: 'rel_off',
      type: 'offset',
      range: { start: 2, end: 4 },
      config: {
        type: 'offset',
        intKind: 'u16',
        endian: 'little',
        base: 'field-start',
        unit: 1,
        anchorField: anchor.hypothesis.id,
      },
    });
    const draft = publishDraft(h.state, {
      hypothesisIds: [anchor.hypothesis.id, off.hypothesis.id],
      label: 'relative',
      notes: '',
      adjudications: [],
    });
    const parse = await loadParser(generateParserModule(draft));
    const result = parse(Uint8Array.from([0x01, 0x00, 0x02, 0x00, 0xaa, 0xbb, 0x41, 0x42]));
    expect(result.ok).toBe(true);
    expect(result.values['rel_off.$target']).toBe(2);
  });
});
