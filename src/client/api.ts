import type {
  AppState,
  Candidate,
  DraftVersion,
  Hypothesis,
  StableDraftExport,
  Verification,
} from '../shared/types';
import { generateParserModule } from '../shared/generator';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(body.error ?? `请求失败 ${response.status}`);
  return body as T;
}

export const api = {
  state: () => request<AppState>('/api/state'),
  addSample: (base64: string, name: string, note: string) =>
    request<{ sample: { id: string }; reusedBlob: boolean }>('/api/samples', {
      method: 'POST',
      body: JSON.stringify({ base64, name, note }),
    }),
  addHypothesis: (payload: unknown) =>
    request<{ hypothesis: Hypothesis; verifications: Verification[] }>('/api/hypotheses', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  retire: (id: string) =>
    request(`/api/hypotheses/${encodeURIComponent(id)}/retire`, { method: 'POST' }),
  verify: () =>
    request<{ verifications: Verification[] }>('/api/verify', { method: 'POST' }),
  refreshCandidates: () =>
    request<{ candidates: Candidate[] }>('/api/candidates/refresh', { method: 'POST' }),
  confirmCandidate: (id: string, name: string) =>
    request(`/api/candidates/${encodeURIComponent(id)}/confirm`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  dismissCandidate: (id: string) =>
    request(`/api/candidates/${encodeURIComponent(id)}/dismiss`, { method: 'POST' }),
  publishDraft: (payload: unknown) =>
    request<{ draft: DraftVersion }>('/api/drafts', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  exportDraft: async (version: number): Promise<StableDraftExport> => {
    const response = await fetch(`/api/drafts/${version}/export`);
    return response.json();
  },
  exportDraftText: async (version: number): Promise<string> => {
    const response = await fetch(`/api/drafts/${version}/export`);
    return response.text();
  },
  generatorText: async (version: number): Promise<string> => {
    const response = await fetch(`/api/drafts/${version}/generator`);
    return response.text();
  },
  parseLocally: async (version: number, bytes: Uint8Array) => {
    const source = await api.generatorText(version);
    const blob = new Blob([source], { type: 'text/javascript' });
    const url = URL.createObjectURL(blob);
    try {
      const module = await import(/* @vite-ignore */ url);
      return module.parse(bytes) as {
        ok: boolean;
        values: Record<string, unknown>;
        errors: Array<{ path: string; offset: number; message: string }>;
      };
    } finally {
      URL.revokeObjectURL(url);
    }
  },
};

export { generateParserModule };
