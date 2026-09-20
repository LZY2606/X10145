import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { base64ToBytes } from '../shared/bytes';
import { emptyState } from '../shared/store';
import type { AppState } from '../shared/types';

export class Repo {
  readonly path: string;
  state: AppState;

  constructor(path: string) {
    this.path = path;
    this.state = this.load();
  }

  private load(): AppState {
    if (!existsSync(this.path)) return emptyState();
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf-8')) as AppState;
      return { ...emptyState(), ...parsed };
    } catch (error) {
      console.error('状态文件损坏，从空状态启动:', error);
      return emptyState();
    }
  }

  save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(this.state));
    renameSync(tmp, this.path);
  }

  sampleBytes(sampleId: string): Uint8Array {
    const sample = this.state.samples[sampleId];
    if (!sample) throw new Error('样本不存在');
    const blob = this.state.blobs[sample.blobSha256];
    if (!blob) throw new Error('blob 缺失');
    return base64ToBytes(blob.base64);
  }
}
