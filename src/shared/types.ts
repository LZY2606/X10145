export type Endianness = 'little' | 'big';

export type IntKind =
  | 'u8'
  | 'u16'
  | 'u24'
  | 'u32'
  | 'u64'
  | 'i8'
  | 'i16'
  | 'i24'
  | 'i32'
  | 'i64';

export type ByteUnit = 1 | 2 | 4 | 8;

export type OffsetBase =
  | 'absolute'
  | 'document-start'
  | 'document-end'
  | 'field-start'
  | 'field-end';

export type StringEncoding = 'ascii' | 'utf8' | 'utf16le' | 'utf16be' | 'latin1';

/** Half-open byte interval [start, end). */
export interface ByteRange {
  start: number;
  end: number;
}

/**
 * A region is either a fixed half-open interval, bytes up to an offset field,
 * bytes between two offset fields, or a sized run starting at a fixed position
 * or at the value of an offset field.
 */
export type RegionSpec =
  | { kind: 'fixed'; start: number; end: number }
  | { kind: 'prefixTo'; endField: string }
  | { kind: 'between'; startField: string; endField: string }
  | {
      kind: 'sized';
      startField: string | null;
      startConst: number;
      lengthField: string;
    };

export type HypothesisType =
  | 'integer'
  | 'string'
  | 'enum'
  | 'offset'
  | 'length'
  | 'offsetTable'
  | 'checksum';

export interface IntegerConfig {
  intKind: IntKind;
  endian: Endianness;
}

export interface StringConfig {
  encoding: StringEncoding;
  trimNul: boolean;
}

export interface EnumConfig {
  intKind: IntKind;
  endian: Endianness;
  /** Decimal integer value -> human label. */
  mapping: Record<string, string>;
}

export interface OffsetConfig {
  intKind: IntKind;
  endian: Endianness;
  base: OffsetBase;
  unit: ByteUnit;
  /** Hypothesis id when base is field-start / field-end. */
  anchorField: string | null;
}

export interface LengthConfig {
  intKind: IntKind;
  endian: Endianness;
  unit: ByteUnit;
  region: RegionSpec;
}

export interface OffsetTableConfig {
  entryKind: IntKind;
  endian: Endianness;
  unit: ByteUnit;
  base: OffsetBase;
  anchorField: string | null;
  /** Fixed number of entries, or a length hypothesis id supplying the count. */
  count: number | { field: string };
}

export type ChecksumAlgorithm =
  | 'xor8'
  | 'sum8'
  | 'sum16-le'
  | 'sum16-be'
  | 'crc32-le'
  | 'crc32-be';

export interface ChecksumConfig {
  algorithm: ChecksumAlgorithm;
  covered: RegionSpec[];
}

export type HypothesisConfig =
  | ({ type: 'integer' } & IntegerConfig)
  | ({ type: 'string' } & StringConfig)
  | ({ type: 'enum' } & EnumConfig)
  | ({ type: 'offset' } & OffsetConfig)
  | ({ type: 'length' } & LengthConfig)
  | ({ type: 'offsetTable' } & OffsetTableConfig)
  | ({ type: 'checksum' } & ChecksumConfig);

export interface Hypothesis {
  id: string;
  name: string;
  type: HypothesisType;
  range: ByteRange;
  config: HypothesisConfig;
  createdAt: string;
  /** Snapshot of the sample set present when the hypothesis was proposed. */
  proposedWithSampleIds: string[];
  createdFromCandidateId?: string;
  retired?: boolean;
}

export type SampleStatus = 'hit' | 'counterexample' | 'inconclusive';

export interface SampleVerification {
  sampleId: string;
  status: SampleStatus;
  detail: string;
  /** Human readable observed bytes/value at the hypothesis range. */
  observed: string;
  /** Human readable expected/computed value, when applicable. */
  expected?: string;
  /** Byte offset a reviewer should jump to (counterexamples). */
  jumpOffset?: number;
}

export interface Verification {
  id: string;
  hypothesisId: string;
  createdAt: string;
  /** Sample ids included in this verification run, in order. */
  sampleIds: string[];
  results: SampleVerification[];
  hitSampleIds: string[];
  counterexampleSampleIds: string[];
  inconclusiveSampleIds: string[];
}

export type CandidateKind = 'length' | 'offset' | 'checksum';

export type CandidateStatus = 'proposed' | 'confirmed' | 'dismissed';

export interface Candidate {
  id: string;
  kind: CandidateKind;
  fieldRange: ByteRange;
  summary: string;
  spec: HypothesisConfig;
  supportSampleIds: string[];
  opposingSampleIds: string[];
  status: CandidateStatus;
  createdAt: string;
  confirmedHypothesisId?: string;
}

export interface BlobRecord {
  sha256: string;
  size: number;
  /** Base64 payload; identical content is stored once. */
  base64: string;
  firstSeenAt: string;
}

export interface SampleRecord {
  id: string;
  blobSha256: string;
  name: string;
  note: string;
  uploadedAt: string;
}

export interface OverlapAdjudication {
  at: string;
  /** Two hypothesis-derived draft field ids that overlap. */
  fieldIds: [string, string];
  winnerFieldId: string;
  range: ByteRange;
}

export type DraftFieldKind = HypothesisType;

export interface DraftField {
  id: string;
  name: string;
  kind: DraftFieldKind;
  /** Declared byte range (half-open). */
  range: ByteRange;
  config: HypothesisConfig;
  sourceHypothesisId: string;
}

export interface DraftVersion {
  id: string;
  version: number;
  label: string;
  notes: string;
  createdAt: string;
  fieldIds: string[];
  fields: DraftField[];
  adjudications: OverlapAdjudication[];
}

export interface AppState {
  blobs: Record<string, BlobRecord>;
  samples: Record<string, SampleRecord>;
  sampleOrder: string[];
  hypotheses: Record<string, Hypothesis>;
  verifications: Verification[];
  candidates: Record<string, Candidate>;
  drafts: DraftVersion[];
  sequence: number;
}

export interface StableDraftExport {
  schema: 'binary-format-inference-bench/draft';
  schemaVersion: 1;
  draft: DraftVersion;
}
