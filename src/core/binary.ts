import type { Endian, IntSize, Signed, Unit } from './types.js';

export function halfOpenValid(start: number, end: number): boolean {
  return (
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    start >= 0 &&
    end >= start
  );
}

/** True when [start, end) is fully contained in a buffer of `size` bytes. */
export function inBounds(size: number, start: number, end: number): boolean {
  return start >= 0 && end <= size && start <= end;
}

export function overlaps(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): boolean {
  return aStart < bEnd && bStart < aEnd;
}

export interface ReadIntResult {
  ok: boolean;
  value?: number;
  atOffset?: number;
  reason?: string;
}

/**
 * Reads a fixed-width integer with explicit bounds checking.
 * Widths up to 6 bytes are exact in JS numbers; 8 byte values use the
 * full BigInt path but return a number only when safely representable.
 */
export function readInt(
  buf: Uint8Array,
  start: number,
  size: IntSize,
  endian: Endian,
  signed: Signed,
): ReadIntResult {
  if (!Number.isInteger(start) || start < 0) {
    return { ok: false, atOffset: Math.max(0, start | 0), reason: 'invalid offset' };
  }
  if (start + size > buf.length) {
    return { ok: false, atOffset: start, reason: 'out of bounds' };
  }
  let raw = 0n;
  if (endian === 'be') {
    for (let i = 0; i < size; i++) raw = (raw << 8n) | BigInt(buf[start + i]);
  } else {
    for (let i = size - 1; i >= 0; i--) raw = (raw << 8n) | BigInt(buf[start + i]);
  }
  if (signed) {
    const signBit = 1n << BigInt(size * 8 - 1);
    if (raw & signBit) raw -= 1n << BigInt(size * 8);
  }
  if (raw > BigInt(Number.MAX_SAFE_INTEGER) || raw < BigInt(Number.MIN_SAFE_INTEGER)) {
    return { ok: false, atOffset: start, reason: 'integer exceeds safe integer range' };
  }
  return { ok: true, value: Number(raw) };
}

/**
 * Scales a field value by a unit and adds a base offset, detecting both
 * numeric overflow and buffer overrun. Returns absolute byte offset.
 */
export function resolveRelative(
  fieldValue: number,
  unit: Unit,
  baseOffset: number,
  bufLen: number,
): { ok: true; offset: number } | { ok: false; atOffset: number; reason: string } {
  if (!Number.isSafeInteger(fieldValue) || !Number.isSafeInteger(baseOffset)) {
    return { ok: false, atOffset: 0, reason: 'non-integer arithmetic' };
  }
  const scaled = fieldValue * unit;
  if (!Number.isSafeInteger(scaled)) {
    return { ok: false, atOffset: baseOffset, reason: 'unit multiplication overflow' };
  }
  const abs = baseOffset + scaled;
  if (!Number.isSafeInteger(abs)) {
    return { ok: false, atOffset: baseOffset, reason: 'base addition overflow' };
  }
  if (abs < 0 || abs > bufLen) {
    return { ok: false, atOffset: Math.min(Math.max(abs, 0), bufLen), reason: 'resolved offset out of bounds' };
  }
  return { ok: true, offset: abs };
}

export function formatHex(value: number | bigint, width?: number): string {
  const n = typeof value === 'bigint' ? value : BigInt(value);
  let s = n < 0n ? '-' + (-n).toString(16) : n.toString(16);
  if (width && n >= 0n) s = s.padStart(width, '0');
  return '0x' + s;
}

export function toHexDump(buf: Uint8Array, base = 0, bytesPerRow = 16): {
  offset: number;
  hex: string[];
  ascii: string;
}[] {
  const rows = [];
  for (let rowStart = 0; rowStart < buf.length; rowStart += bytesPerRow) {
    const slice = buf.subarray(rowStart, Math.min(rowStart + bytesPerRow, buf.length));
    const hex: string[] = [];
    let ascii = '';
    for (const b of slice) {
      hex.push(b.toString(16).padStart(2, '0'));
      ascii += b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '·';
    }
    rows.push({ offset: base + rowStart, hex, ascii });
  }
  return rows;
}

export async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
