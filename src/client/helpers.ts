import type { AppState, ByteRange, Hypothesis, SampleRecord, Verification } from '../shared/types';
import { hypothesisStatus, latestVerification } from '../shared/semantics';
import { base64ToBytes } from '../shared/bytes';

export function fileToBytes(file: File): Promise<Uint8Array> {
  return file.arrayBuffer().then((buffer) => new Uint8Array(buffer));
}

export function bytesToBase64Browser(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function sampleBytes(state: AppState, sample: SampleRecord): Uint8Array {
  const blob = state.blobs[sample.blobSha256];
  return base64ToBytes(blob.base64);
}

export function statusLabel(
  state: AppState,
  hypothesisId: string,
): { label: string; className: string } {
  const status = hypothesisStatus(state, hypothesisId);
  switch (status) {
    case 'hit':
      return { label: '全部命中', className: 'status-hit' };
    case 'counterexample':
      return { label: '存在反例', className: 'status-counter' };
    case 'mixed':
      return { label: '部分命中', className: 'status-mixed' };
    case 'inconclusive':
      return { label: '无法判定', className: 'status-inconclusive' };
    default:
      return { label: '未验证', className: 'status-inconclusive' };
  }
}

export function verificationFor(
  state: AppState,
  hypothesisId: string,
): Verification | undefined {
  return latestVerification(state, hypothesisId);
}

export function rangeText(range: ByteRange): string {
  return `[${range.start}, ${range.end}) · ${range.end - range.start}B`;
}

export function rangesOverlap(a: ByteRange, b: ByteRange): boolean {
  return a.start < b.end && b.start < a.end;
}

export function downloadText(filename: string, text: string, type: string): void {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export function typeLabel(hypothesis: Hypothesis): string {
  const labels: Record<string, string> = {
    integer: '整数',
    string: '字符串',
    enum: '枚举',
    offset: '偏移',
    length: '长度',
    offsetTable: '偏移表',
    checksum: '校验',
  };
  return labels[hypothesis.type] ?? hypothesis.type;
}
