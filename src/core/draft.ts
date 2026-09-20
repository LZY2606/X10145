import type {
  Adjudication,
  AppState,
  Draft,
  DraftField,
  DraftVersion,
  Hypothesis,
  OverlapPair,
} from './types.js';
import { overlaps } from './binary.js';
export type CanonicalHasher = (canonical: string) => string;

const fnv1a64: CanonicalHasher = (input) => {
  let hi = 0xcbf29ce4;
  let lo = 0x84222325;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    lo ^= c;
    hi = Math.imul(hi, 0x01000193) ^ Math.imul(lo >>> 0, 0x01000193);
    lo = Math.imul(lo, 0x01000193);
  }
  return (
    'fnv1a64:' +
    (hi >>> 0).toString(16).padStart(8, '0') +
    (lo >>> 0).toString(16).padStart(8, '0')
  );
};

export function pairKey(a: string, b: string): string {
  return [a, b].sort().join('|');
}

/** All pairwise overlapping hypothesis intervals in the supplied set. */
export function findOverlaps(hypotheses: Hypothesis[], adjudications: Record<string, Adjudication>): OverlapPair[] {
  const result: OverlapPair[] = [];
  for (let i = 0; i < hypotheses.length; i++) {
    for (let j = i + 1; j < hypotheses.length; j++) {
      const a = hypotheses[i];
      const b = hypotheses[j];
      if (!overlaps(a.start, a.end, b.start, b.end)) continue;
      const key = pairKey(a.id, b.id);
      const adj = adjudications[key];
      result.push({
        a: a.id,
        b: b.id,
        aStart: a.start,
        aEnd: a.end,
        bStart: b.start,
        bEnd: b.end,
        adjudicated: !!adj,
        winner: adj?.winner,
      });
    }
  }
  return result;
}

export class DraftPublicationError extends Error {
  unresolved: OverlapPair[];
  constructor(unresolved: OverlapPair[]) {
    super(
      `存在 ${unresolved.length} 对未裁决的重叠区间：` +
        unresolved.map((p) => `${p.a} <-> ${p.b}`).join('; '),
    );
    this.name = 'DraftPublicationError';
    this.unresolved = unresolved;
  }
}

export function toDraftField(h: Hypothesis): DraftField {
  return { hypothesisId: h.id, label: h.label, start: h.start, end: h.end, spec: h.spec };
}

/** Recursively sort object keys so identical drafts always serialize identically. */
export function stableStringify(value: unknown): string {
  const sorted = sortValue(value);
  return JSON.stringify(sorted, null, 2);
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export interface PublishArgs {
  draft: Draft;
  selectedHypothesisIds: string[];
  state: AppState;
  note: string;
  now?: string;
  hasher?: CanonicalHasher;
}

/**
 * Produces the next immutable draft version. Overlapping interpretations may
 * coexist in the hypothesis workspace ("staged"), but publication requires an
 * explicit adjudication for every overlapping pair.
 */
export function buildVersion(args: PublishArgs): { draft: Draft; version: DraftVersion } {
  const now = args.now ?? new Date().toISOString();
  const selected = args.selectedHypothesisIds
    .map((id) => args.state.hypotheses[id])
    .filter((h): h is Hypothesis => !!h);

  const overlapPairs = findOverlaps(selected, args.state.adjudications);
  const unresolved = overlapPairs.filter((p) => !p.adjudicated);
  if (unresolved.length > 0) throw new DraftPublicationError(unresolved);

  const fields = selected
    .map(toDraftField)
    .sort((x, y) => x.start - y.start || x.end - y.end || x.hypothesisId.localeCompare(y.hypothesisId));

  const relevantAdjudications = overlapPairs
    .map((p) => args.state.adjudications[pairKey(p.a, p.b)])
    .filter((a): a is Adjudication => !!a)
    .sort((x, y) => x.pairKey.localeCompare(y.pairKey));

  const version: DraftVersion = {
    version: (args.draft.publishedVersion ?? 0) + 1,
    createdAt: now,
    note: args.note,
    fields,
    adjudications: relevantAdjudications,
    canonicalHash: '',
  };
  const canonical = stableStringify(exportVersionShape(version));
  version.canonicalHash = (args.hasher ?? fnv1a64)(canonical);

  const draft: Draft = {
    ...args.draft,
    updatedAt: now,
    publishedVersion: version.version,
    versions: [...args.draft.versions, version],
  };
  return { draft, version };
}

export interface StableDraftExport {
  format: 'binary-format-inference-bench/draft';
  exportSchema: 1;
  draftId: string;
  name: string;
  version: number;
  createdAt: string;
  note: string;
  fields: DraftField[];
  adjudications: Adjudication[];
  canonicalHash: string;
}

export function exportVersionShape(version: DraftVersion): Omit<StableDraftExport, 'draftId' | 'name'> {
  return {
    format: 'binary-format-inference-bench/draft',
    exportSchema: 1,
    version: version.version,
    createdAt: version.createdAt,
    note: version.note,
    fields: version.fields,
    adjudications: version.adjudications,
    canonicalHash: version.canonicalHash,
  };
}

export function buildStableExport(draft: Draft, versionNumber?: number): StableDraftExport {
  const v =
    draft.versions.find((x) => x.version === versionNumber) ??
    draft.versions[draft.versions.length - 1];
  if (!v) throw new Error('draft has no published versions');
  return {
    ...exportVersionShape(v),
    draftId: draft.id,
    name: draft.name,
  };
}

export function exportCanonicalJson(draft: Draft, versionNumber?: number): string {
  return stableStringify(buildStableExport(draft, versionNumber));
}
