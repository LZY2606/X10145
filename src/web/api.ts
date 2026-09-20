import type { AppState, OverlapPair } from '../core/types.js';

export interface StateResponse extends AppState {
  overlapPairs: OverlapPair[];
  samples: AppState['samples'] & Record<string, { size: number; sha256: string }>;
}

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body as T;
}

export const api = {
  state: () => jsonFetch<StateResponse>('/api/state'),
  sampleBytes: (id: string) => fetch(`/api/samples/${id}/bytes`).then((r) => r.arrayBuffer()),
  upload: async (bytes: Uint8Array, note: string) => {
    const res = await fetch(`/api/samples?note=${encodeURIComponent(note)}`, {
      method: 'POST',
      body: bytes,
      headers: { 'content-type': 'application/octet-stream' },
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error);
    return body as { deduped: boolean };
  },
  deleteSample: (id: string) => jsonFetch(`/api/samples/${id}`, { method: 'DELETE' }),
  addHypothesis: (payload: unknown) =>
    jsonFetch('/api/hypotheses', {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: { 'content-type': 'application/json' },
    }),
  rerun: (id: string) => jsonFetch(`/api/hypotheses/${id}/rerun`, { method: 'POST' }),
  discover: () => jsonFetch('/api/candidates/discover', { method: 'POST' }),
  confirmCandidate: (id: string) => jsonFetch(`/api/candidates/${id}/confirm`, { method: 'POST' }),
  dismissCandidate: (id: string) => jsonFetch(`/api/candidates/${id}/dismiss`, { method: 'POST' }),
  adjudicate: (payload: unknown) =>
    jsonFetch('/api/adjudications', {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: { 'content-type': 'application/json' },
    }),
  createDraft: (name: string) =>
    jsonFetch('/api/drafts', {
      method: 'POST',
      body: JSON.stringify({ name }),
      headers: { 'content-type': 'application/json' },
    }),
  publishDraft: (id: string, hypothesisIds: string[], note: string) =>
    jsonFetch(`/api/drafts/${id}/publish`, {
      method: 'POST',
      body: JSON.stringify({ hypothesisIds, note }),
      headers: { 'content-type': 'application/json' },
    }),
  exportUrl: (id: string, version?: number) =>
    `/api/drafts/${id}/export${version ? `?version=${version}` : ''}`,
  parserUrl: (id: string, version?: number) =>
    `/api/drafts/${id}/parser${version ? `?version=${version}` : ''}`,
};
