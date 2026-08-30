export interface DiffFile {
  path: string;
  oldPath?: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  chunks: DiffChunk[];
  isGenerated?: boolean;
  /** Git reported a binary difference ("Binary files … differ"); no chunks to render. */
  isBinary?: boolean;
}

export interface DiffChunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface DiffLine {
  type: 'add' | 'delete' | 'normal' | 'hunk' | 'remove' | 'context' | 'header';
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

export type DiffViewMode = 'split' | 'unified' | 'full';
type FilePreviewMode = 'diff-preview' | 'full-preview';
export type FileViewMode = DiffViewMode | FilePreviewMode;
export type DiffSide = 'old' | 'new';
export type DiffLineRange = number | { start: number; end: number };

export interface DiffCommentPosition {
  side: DiffSide;
  line: DiffLineRange;
}

export interface DiffCommentCodeSnapshot {
  content: string;
  language?: string;
}

export type BaseMode = 'direct' | 'merge-base';

export interface DiffSelection {
  baseCommitish: string;
  targetCommitish: string;
  baseMode?: BaseMode;
}

export interface DiffResponse {
  commit: string;
  files: DiffFile[];
  ignoreWhitespace?: boolean;
  isEmpty?: boolean;
  baseCommitish?: string;
  targetCommitish?: string;
  requestedBaseCommitish?: string;
  requestedTargetCommitish?: string;
  requestedBaseMode?: BaseMode;
  clearComments?: boolean;
  repositoryId?: string;
}

export interface GeneratedStatusResponse {
  path: string;
  ref: string;
  isGenerated: boolean;
  source: 'path' | 'content';
}

/** One narration card: the file's narrative; card order is the review order. */
interface NarrationCard {
  path: string;
  narrative: string;
}

export interface Narration {
  intro: string;
  cards: NarrationCard[];
  epilogue: string;
}

/** What a callable symbol takes and produces, phrased by parameter name or in prose. */
interface FileExplanationContract {
  input: string;
  output: string;
}

/** One entry of a whole-file outline; order is the suggested reading order. */
interface FileExplanationSymbol {
  name: string;
  type: 'function' | 'method' | 'class' | 'constant' | 'other';
  summary: string;
  /** Part of the file's public API (exported, reachable from other files) vs. private/internal. */
  isPublic: boolean;
  contract?: FileExplanationContract;
}

export interface FileExplanation {
  fileSummary: string;
  symbols: FileExplanationSymbol[];
  /** Paths offered to the model; always empty on a final-round answer. */
  additionalFilesNeeded: string[];
}

export type LineNumber = number | [number, number];

export interface Comment {
  id: string;
  file: string;
  line: LineNumber;
  body: string;
  timestamp: string;
  author?: string;
  codeContent?: string;
  side?: DiffSide;
}

export interface LineSelection {
  side: DiffSide;
  lineNumber: number;
}

export interface LegacyDiffComment {
  id: string;
  filePath: string;
  body: string;
  author?: string;
  createdAt: string; // ISO 8601 format
  updatedAt: string; // ISO 8601 format

  position: DiffCommentPosition;

  codeSnapshot?: DiffCommentCodeSnapshot;
}

export interface DiffCommentMessage {
  id: string;
  body: string;
  author?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DiffCommentThread {
  id: string;
  filePath: string;
  createdAt: string; // ISO 8601 format
  updatedAt: string; // ISO 8601 format

  position: DiffCommentPosition;

  codeSnapshot?: DiffCommentCodeSnapshot;

  messages: DiffCommentMessage[];
}

export interface ViewedFileRecord {
  filePath: string;
  viewedAt: string; // ISO 8601 format
  diffContentHash: string; // SHA-256 hash
}

export interface ViewedHashIndexEntry {
  filePath: string;
  diffContentHash: string;
  hashVersion: 1;
  viewedAt: string; // ISO 8601 format
}

export interface ViewedHashIndex {
  version: 1;
  lastModifiedAt: string; // ISO 8601 format
  entries: ViewedHashIndexEntry[];
}

export interface LegacyDiffContextStorage {
  version: 1; // Schema version
  baseCommitish: string;
  targetCommitish: string;
  createdAt: string; // ISO 8601 format
  lastModifiedAt: string; // ISO 8601 format

  comments: LegacyDiffComment[];
  viewedFiles: ViewedFileRecord[];
}

export interface DiffContextStorage {
  version: 2; // Schema version
  baseCommitish: string;
  targetCommitish: string;
  baseMode?: BaseMode;
  createdAt: string; // ISO 8601 format
  lastModifiedAt: string; // ISO 8601 format

  threads: DiffCommentThread[];
  viewedFiles: ViewedFileRecord[];
}

export interface CommentThread {
  id: string;
  file: string;
  line: LineNumber;
  side?: DiffSide;
  createdAt: string;
  updatedAt: string;
  codeContent?: string;
  isOutdated?: boolean;
  messages: DiffCommentMessage[];
}

interface RevisionOption {
  value: string;
  label: string;
}

interface BranchInfo {
  name: string;
  current: boolean;
}

export interface CommitInfo {
  hash: string;
  shortHash: string;
  message: string;
}

export interface RevisionsResponse {
  specialOptions: RevisionOption[];
  branches: BranchInfo[];
  commits: CommitInfo[];
  originDefaultBranch?: string;
  resolvedBase?: string;
  resolvedTarget?: string;
}

export interface ExpandedLinesState {
  [filePath: string]: FileExpandedState;
}

export interface FileExpandedState {
  oldContent?: string[];
  newContent?: string[];
  expandedRanges: ExpandedRange[];
  oldTotalLines?: number;
  newTotalLines?: number;
}

interface ExpandedRange {
  chunkIndex: number;
  direction: 'up' | 'down';
  count: number;
}

export interface ExpandedLine extends DiffLine {
  isExpanded?: boolean;
}
