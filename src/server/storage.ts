import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { AppState } from '../core/types.js';

const EMPTY_STATE: AppState = {
  blobs: {},
  samples: {},
  hypotheses: {},
  runs: {},
  candidates: {},
  drafts: {},
  adjudications: {},
};

export class Storage {
  readonly dir: string;
  private readonly statePath: string;
  private readonly blobsDir: string;
  private state: AppState;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
    this.blobsDir = join(dir, 'blobs');
    mkdirSync(this.blobsDir, { recursive: true });
    this.statePath = join(dir, 'state.json');
    this.state = this.loadState();
  }

  private loadState(): AppState {
    if (!existsSync(this.statePath)) {
      return structuredClone(EMPTY_STATE);
    }
    try {
      const parsed = JSON.parse(readFileSync(this.statePath, 'utf8')) as Partial<AppState>;
      return {
        blobs: parsed.blobs ?? {},
        samples: parsed.samples ?? {},
        hypotheses: parsed.hypotheses ?? {},
        runs: parsed.runs ?? {},
        candidates: parsed.candidates ?? {},
        drafts: parsed.drafts ?? {},
        adjudications: parsed.adjudications ?? {},
      };
    } catch (err) {
      const backup = this.statePath + '.corrupt-' + Date.now();
      renameSync(this.statePath, backup);
      console.error(`state.json unreadable, moved to ${backup}`, err);
      return structuredClone(EMPTY_STATE);
    }
  }

  getState(): AppState {
    return this.state;
  }

  /** Persist atomically so a crash mid-write never destroys history. */
  saveState(next: AppState): void {
    this.state = next;
    const tmp = this.statePath + '.tmp';
    writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
    renameSync(tmp, this.statePath);
  }

  blobPath(blobId: string): string {
    return join(this.blobsDir, blobId);
  }

  writeBlob(blobId: string, bytes: Uint8Array): void {
    const p = this.blobPath(blobId);
    if (!existsSync(p)) writeFileSync(p, bytes);
  }

  readBlob(blobId: string): Uint8Array {
    return new Uint8Array(readFileSync(this.blobPath(blobId)));
  }
}
