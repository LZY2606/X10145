import type {
  ChecksumAlgorithm,
  Endianness,
  IntKind,
  StringEncoding,
} from './types';

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export const INT_WIDTH: Record<IntKind, number> = {
  u8: 1,
  i8: 1,
  u16: 2,
  i16: 2,
  u24: 3,
  i24: 3,
  u32: 4,
  i32: 4,
  u64: 8,
  i64: 8,
};

function isSigned(kind: IntKind): boolean {
  return kind.startsWith('i');
}

/**
 * Decode an integer. Returns the value as a bigint so 64-bit fields never
 * lose precision; callers compare against values converted with toBig.
 */
export function decodeInt(
  bytes: Uint8Array,
  offset: number,
  kind: IntKind,
  endian: Endianness,
): bigint {
  const width = INT_WIDTH[kind];
  let value = 0n;
  if (endian === 'little') {
    for (let i = width - 1; i >= 0; i--) {
      value = (value << 8n) | BigInt(bytes[offset + i]);
    }
  } else {
    for (let i = 0; i < width; i++) {
      value = (value << 8n) | BigInt(bytes[offset + i]);
    }
  }
  if (isSigned(kind)) {
    const bits = BigInt(width * 8);
    const signBit = 1n << (bits - 1n);
    if ((value & signBit) !== 0n) value -= 1n << bits;
  }
  return value;
}

export function bigintToDisplay(value: bigint): string {
  return value.toString();
}

export function toBig(value: number | bigint): bigint {
  return typeof value === 'bigint' ? value : BigInt(value);
}

const TEXT_DECODER = new TextDecoder('utf-16le', { fatal: false });

export function decodeString(
  bytes: Uint8Array,
  start: number,
  end: number,
  encoding: StringEncoding,
): string {
  const slice = bytes.subarray(start, end);
  if (encoding === 'utf16le') return TEXT_DECODER.decode(slice);
  if (encoding === 'utf16be') {
    const swapped = new Uint8Array(slice.length);
    for (let i = 0; i + 1 < slice.length; i += 2) {
      swapped[i] = slice[i + 1];
      swapped[i + 1] = slice[i];
    }
    return TEXT_DECODER.decode(swapped);
  }
  let result = '';
  for (const byte of slice) {
    if (encoding === 'ascii') {
      result += byte < 0x80 ? String.fromCharCode(byte) : '\\x' + byte.toString(16).padStart(2, '0');
    } else if (encoding === 'latin1') {
      result += String.fromCharCode(byte);
    } else {
      result += String.fromCharCode(byte);
    }
  }
  if (encoding === 'utf8' || encoding === 'latin1') {
    try {
      return new TextDecoder(encoding === 'utf8' ? 'utf-8' : 'latin1').decode(slice);
    } catch {
      return result;
    }
  }
  return result;
}

export function trimNulString(text: string): string {
  return text.replace(/\0+$/, '');
}

export function stringPreview(value: string, max = 24): string {
  const flat = value.replace(/[\x00-\x1f]/g, (c) =>
    c === '\t' ? ' ' : '·',
  );
  return flat.length > max ? flat.slice(0, max) + '…' : flat;
}

export function hexPreview(bytes: Uint8Array, start: number, end: number): string {
  const parts: string[] = [];
  for (let i = start; i < end; i++) parts.push(bytes[i].toString(16).padStart(2, '0'));
  return parts.join(' ');
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function checksum(
  data: Uint8Array,
  algorithm: ChecksumAlgorithm,
): bigint {
  switch (algorithm) {
    case 'xor8': {
      let value = 0;
      for (const byte of data) value ^= byte;
      return BigInt(value);
    }
    case 'sum8': {
      let value = 0;
      for (const byte of data) value = (value + byte) & 0xff;
      return BigInt(value);
    }
    case 'sum16-le':
    case 'sum16-be': {
      const endian: Endianness = algorithm === 'sum16-le' ? 'little' : 'big';
      let value = 0n;
      for (const byte of data) value += BigInt(byte);
      value &= 0xffffn;
      if (endian === 'little') {
        value = ((value & 0xffn) << 8n) | ((value >> 8n) & 0xffn);
      }
      return value;
    }
    case 'crc32-le':
    case 'crc32-be': {
      const value = BigInt(crc32(data));
      if (algorithm === 'crc32-le') {
        const b0 = value & 0xffn;
        const b1 = (value >> 8n) & 0xffn;
        const b2 = (value >> 16n) & 0xffn;
        const b3 = (value >> 24n) & 0xffn;
        return (b0 << 24n) | (b1 << 16n) | (b2 << 8n) | b3;
      }
      return value;
    }
  }
}

/** Range covers bytes [start,end) and must fit inside a length-sized buffer. */
export function rangeInBounds(
  start: number,
  end: number,
  length: number,
): boolean {
  return (
    Number.isSafeInteger(start) &&
    Number.isSafeInteger(end) &&
    start >= 0 &&
    end >= start &&
    end <= length
  );
}

export function overlaps(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && b.start < a.end;
}
