import { describe, expect, it } from 'vitest';
import { harness } from './helpers';
import { fieldsFromHypotheses, findOverlaps, publishDraft } from '../src/shared/store';

describe('重叠解释与草案裁决', () => {
  it('重叠假设可以同时暂存，但发布草案必须显式裁决', () => {
    const h = harness();
    h.add('s', [1, 2, 3, 4, 5, 6, 7, 8]);
    const a = h.hyp(h.state, h.blobs, {
      name: 'word_a',
      type: 'integer',
      range: { start: 0, end: 4 },
      config: { type: 'integer', intKind: 'u32', endian: 'little' },
    });
    const b = h.hyp(h.state, h.blobs, {
      name: 'word_b',
      type: 'integer',
      range: { start: 2, end: 6 },
      config: { type: 'integer', intKind: 'u32', endian: 'little' },
    });
    // 重叠假设共存
    expect(h.state.hypotheses[a.hypothesis.id]).toBeTruthy();
    expect(h.state.hypotheses[b.hypothesis.id]).toBeTruthy();

    const fields = fieldsFromHypotheses(h.state.hypotheses, [a.hypothesis.id, b.hypothesis.id]);
    expect(findOverlaps(fields)).toHaveLength(1);

    expect(() =>
      publishDraft(h.state, {
        hypothesisIds: [a.hypothesis.id, b.hypothesis.id],
        label: 'v1',
        notes: '',
        adjudications: [],
      }),
    ).toThrow(/未裁决的重叠/);

    const draft = publishDraft(h.state, {
      hypothesisIds: [a.hypothesis.id, b.hypothesis.id],
      label: 'v1',
      notes: '决定采用 word_a',
      adjudications: [
        { fieldAId: `field_${a.hypothesis.id}`, fieldBId: `field_${b.hypothesis.id}`, winnerFieldId: `field_${a.hypothesis.id}` },
      ],
    });
    expect(draft.version).toBe(1);
    expect(draft.fields.map((f) => f.name)).toEqual(['word_a']);
    expect(draft.adjudications).toHaveLength(1);
    expect(draft.adjudications[0].winnerFieldId).toBe(`field_${a.hypothesis.id}`);

    const second = publishDraft(h.state, {
      hypothesisIds: [a.hypothesis.id, b.hypothesis.id],
      label: 'v2',
      notes: '',
      adjudications: [
        { fieldAId: `field_${a.hypothesis.id}`, fieldBId: `field_${b.hypothesis.id}`, winnerFieldId: `field_${b.hypothesis.id}` },
      ],
    });
    expect(second.version).toBe(2);
    expect(second.fields.map((f) => f.name)).toEqual(['word_b']);
  });
});
