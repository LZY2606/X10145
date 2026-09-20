// Core domain types for the binary format inference bench.
// All byte intervals are half-open: [start, end).

export type Endian = 'le' | 'be';
export type IntSize = 1 | 2 | 4 | 8;
export type Signed = boolean;
export type Unit = 1 | 2 | 4;

export type HypothesisKind =
  | 'integer'
  | 'string'
  | 'enum'
  | 'offset_table'
  | 'length'
  | 'checksum';

export type ChecksumAlgorithm = 'sum8' | 'sum16' | 'xor8';

/** Where a relative offset/length base points. */
export type BaseRef =
  | { kind: 'start' }
  | { kind: 'end' }
  | { kind: 'field_start' }
  | { kind: 'region'; hypothesisId: string };

/** Target whose length a `length` hypothesis compares against. */
export type LengthTarget =
  | { kind: 'file' }
  | { kind: 'eof_remaining'; from: number }
  | { kind: 'region'; hypothesisId: string };

/** Bytes covered by a checksum. */
export type ChecksumRange =
  | { kind: 'absolute'; start: number; end: number }
  | { kind: 'region'; hypothesisId: string };

export interface IntegerSpec {
  endian: Endian;
  size: IntSize;
  signed: Signed;
}

export interface StringSpec {
  encoding: 'ascii' | 'utf8';
  requireNullTerminator: boolean;
  allowPrintableOnly: boolean;
}

export interface EnumSpec {
  endian: Endian;
  size: IntSize;
  signed: Signed;
  members: { name: string; value: number }[];
}

export interface OffsetTableSpec {
  endian: Endian;
  entrySize: 2 | 4 | 8;
  count: number;
  base: BaseRef;
  unit: Unit;
}

export interface LengthSpec {
  endian: Endian;
  size: IntSize;
  signed: Signed;
  unit: Unit;
  target: LengthTarget;
}

export interface ChecksumSpec {
  endian: Endian;
  size: IntSize;
  algorithm: ChecksumAlgorithm;
  ranges: ChecksumRange[];
}

export type Spec =
  | ({ kind: 'integer' } & IntegerSpec)
  | ({ kind: 'string' } & StringSpec)
  | ({ kind: 'enum' } & EnumSpec)
  | ({ kind: 'offset_table' } & OffsetTableSpec)
  | ({ kind: 'length' } & LengthSpec)
  | ({ kind: 'checksum' } & ChecksumSpec);

export interface Blob {
  id: string;
  sha256: string;
  size: number;
  createdAt: string;
}

export interface Sample {
  id: string;
  blobId: string;
  note: string;
  createdAt: string;
}

export type Verdict = 'hit' | 'counterexample' | 'out_of_bounds';

export interface SampleResult {
  sampleId: string;
  verdict: Verdict;
  /** Human-readable decoded representation. */
  value: string;
  /** Numeric value when applicable (integer/enum/length/checksum/offset entries). */
  numeric?: number | number[];
  /** Absolute byte offset that explains a counterexample, for jump-to-byte. */
  atOffset?: number;
  detail?: string;
}

export interface ValidationRun {
  id: string;
  hypothesisId: string;
  at: string;
  /** Sample set present at proposal time. */
  sampleSetAtProposal: string[];
  /** Sample set this run was evaluated against. */
  sampleSet: string[];
  trigger: 'proposal' | 'sample_added' | 'manual' | 'sample_removed';
  results: SampleResult[];
  hits: number;
  counterexamples: number;
  outOfBounds: number;
}

export interface Hypothesis {
  id: string;
  label: string;
  start: number;
  end: number;
  spec: Spec;
  createdAt: string;
  proposedWithSamples: string[];
  /** Candidate this hypothesis was promoted from, if any. */
  fromCandidateId?: string;
  runIds: string[];
}

export type CandidateKind = 'length_relation' | 'checksum_relation' | 'constant';

export interface Candidate {
  id: string;
  /** Stable identity across re-discoveries, independent of support counts. */
  signature: string;
  kind: CandidateKind;
  start: number;
  end: number;
  description: string;
  spec: Spec;
  supportSampleIds: string[];
  supportCount: number;
  totalSamples: number;
  discoveredAt: string;
  updatedAt: string;
  status: 'proposed' | 'confirmed' | 'dismissed';
  confirmedAt?: string;
}

export interface Adjudication {
  /** Sorted pair "idA|idB" of overlapping hypotheses. */
  pairKey: string;
  a: string;
  b: string;
  winner: string;
  reason: string;
  at: string;
}

export interface DraftField {
  hypothesisId: string;
  label: string;
  start: number;
  end: number;
  spec: Spec;
}

export interface DraftVersion {
  version: number;
  createdAt: string;
  note: string;
  fields: DraftField[];
  adjudications: Adjudication[];
  /** sha256 of the canonical stable JSON of this version. */
  canonicalHash: string;
}

export interface Draft {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  publishedVersion: number | null;
  versions: DraftVersion[];
}

export interface AppState {
  blobs: Record<string, Blob>;
  samples: Record<string, Sample>;
  hypotheses: Record<string, Hypothesis>;
  runs: Record<string, ValidationRun>;
  candidates: Record<string, Candidate>;
  drafts: Record<string, Draft>;
  adjudications: Record<string, Adjudication>;
}

export interface OverlapPair {
  a: string;
  b: string;
  aStart: number;
  aEnd: number;
  bStart: number;
  bEnd: number;
  adjudicated: boolean;
  winner?: string;
}
