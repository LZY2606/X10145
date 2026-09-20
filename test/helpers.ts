import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Storage } from '../src/server/storage.js';
import { Service } from '../src/server/service.js';

export function makeService(): { service: Service; storage: Storage; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'bfib-'));
  const storage = new Storage(dir);
  const service = new Service(storage);
  return { service, storage, dir };
}

export function buildBytes(parts: (number | string | number[])[]): Uint8Array {
  const out: number[] = [];
  for (const part of parts) {
    if (typeof part === 'number') out.push(part);
    else if (typeof part === 'string') for (const ch of part) out.push(ch.charCodeAt(0));
    else out.push(...part);
  }
  return Uint8Array.from(out);
}

export function u16(value: number, endian: 'le' | 'be' = 'le'): number[] {
  const b = [value & 0xff, (value >>> 8) & 0xff];
  return endian === 'le' ? b : b.reverse();
}

export function u32(value: number, endian: 'le' | 'be' = 'le'): number[] {
  const b = [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
  return endian === 'le' ? b : b.reverse();
}

export function u8(value: number): number {
  return value & 0xff;
}
