import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyState, addSample, addHypothesis } from '../src/shared/store';
import type { SampleBlob } from '../src/shared/semantics';
import type { AppState } from '../src/shared/types';

export function makeTempPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'bfib-')), 'state.json');
}

export interface Harness {
  state: AppState;
  blobs: Map<string, SampleBlob>;
  add: (name: string, bytes: number[] | Uint8Array, note?: string) => string;
  hyp: typeof addHypothesisImpl;
}

function addHypothesisImpl(...args: Parameters<typeof import('../src/shared/store').addHypothesis>) {
  return addHypothesis(...args);
}

export function harness(): Harness {
  const state = emptyState();
  const blobs = new Map<string, SampleBlob>();
  const add = (name: string, data: number[] | Uint8Array, note = '') => {
    const bytes = data instanceof Uint8Array ? data : Uint8Array.from(data);
    const result = addSample(state, { name, note, bytes }, blobs);
    return result.sample.id;
  };
  return {
    state,
    blobs,
    add,
    hyp: (hState: AppState, hBlobs: Map<string, SampleBlob>, input: Parameters<typeof addHypothesis>[2]) =>
      addHypothesis(hState, hBlobs, input),
  };
}

export function bytes(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}
