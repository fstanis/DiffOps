/** Parsers for lg2 (wasm-git) stdout and git metadata files, all pure. */

/** One commit of lg2 `log` output. */
export interface ParsedCommit {
  hash: string;
  message: string;
}

const COMMIT_HEADER_PATTERN = /^commit ([0-9a-f]{40})$/;
const MESSAGE_INDENT = '    ';

/**
 * Parses lg2 `log` output (the git log default format: `commit <hash>`,
 * `Author:`/`Date:`/`Merge:` lines, then 4-space indented message paragraphs).
 */
export const parseLg2Log = (stdout: string): ParsedCommit[] => {
  const commits: ParsedCommit[] = [];
  let currentHash: string | null = null;
  let messageLines: string[] = [];

  const flushCommit = () => {
    if (currentHash !== null) {
      while (messageLines.length > 0 && messageLines[messageLines.length - 1] === '') {
        messageLines.pop();
      }
      commits.push({ hash: currentHash, message: messageLines.join('\n') });
    }
    currentHash = null;
    messageLines = [];
  };

  for (const line of stdout.split('\n')) {
    const headerMatch = line.match(COMMIT_HEADER_PATTERN);
    if (headerMatch) {
      flushCommit();
      currentHash = headerMatch[1] ?? '';
      continue;
    }
    if (currentHash === null) {
      continue;
    }
    if (line.startsWith(MESSAGE_INDENT)) {
      messageLines.push(line.slice(MESSAGE_INDENT.length));
    } else if (line === '' && messageLines.length > 0) {
      // Paragraph separator inside the message; a following indented line
      // continues it, the next `commit` header ends it.
      messageLines.push('');
    }
  }
  flushCommit();

  return commits;
};

/** One ref of lg2 `for-each-ref` output: `<hash> <type>\t<refname>`. */
export interface ParsedRef {
  hash: string;
  type: string;
  name: string;
}

/** Parses lg2 `for-each-ref` output (one `<hash> <type>\t<refname>` line per ref). */
export const parseLg2ForEachRef = (stdout: string): ParsedRef[] => {
  const refs: ParsedRef[] = [];
  for (const line of stdout.split('\n')) {
    const match = line.match(/^([0-9a-f]{40}) (\S+)\t(\S+)$/);
    if (match) {
      refs.push({ hash: match[1] ?? '', type: match[2] ?? '', name: match[3] ?? '' });
    }
  }
  return refs;
};

/**
 * Extracts the ref a `.git/HEAD` file points at (`ref: refs/heads/main`), or
 * null for a detached HEAD (a raw hash).
 */
export const parseHeadRef = (headContent: string): string | null => {
  const match = headContent.match(/^ref: (\S+)/);
  return match?.[1] ?? null;
};

/** Extracts `refs/remotes/origin/<branch>` out of a `.git/refs/remotes/origin/HEAD` file. */
export const parseOriginHeadRef = (originHeadContent: string): string | null => {
  const ref = parseHeadRef(originHeadContent);
  const match = ref?.match(/^refs\/remotes\/origin\/(\S+)$/);
  return match?.[1] ?? null;
};

const ENTRY_FIXED_BYTES_V2 = 62;
const ENTRY_EXTENDED_BYTES_V2 = 2;
const ENTRY_ALIGNMENT = 8;
const LONG_PATH_MASK = 0xfff;
const STAGE_MASK = 0x3;
const STAGE_SHIFT = 12;
const EXTENDED_FLAG = 0x4000;
const SYMLINK_MODE = 0o120000;
const GITLINK_MODE = 0o160000;
const TREE_MODE = 0o040000;
const TRAILING_HASH_BYTES = 20;

/** One entry of a git index file at any stage. */
interface RawIndexEntry {
  path: string;
  sha: string;
  mode: number;
  stage: number;
}

interface ParsedIndexBody {
  entries: RawIndexEntry[];
  extensionSignatures: string[];
}

// git's offset varint (varint.c): 7 bits per byte, big-endian, where every
// continuation byte adds one to the shifted accumulator.
const decodeOffsetVarint = (bytes: Uint8Array, offset: number): { value: number; next: number } => {
  let byte = bytes[offset] ?? 0;
  let value = byte & 0x7f;
  let position = offset;
  while (byte & 0x80) {
    position += 1;
    byte = bytes[position] ?? 0;
    value = ((value + 1) << 7) | (byte & 0x7f);
  }
  return { value, next: position + 1 };
};

/**
 * Parses a git index file (formats v2/v3/v4) into every entry (all stages,
 * including the empty-path replacements a split index carries) plus the
 * extension signatures that follow them. Throws on other versions or a
 * truncated file.
 */
const parseIndexBody = (bytes: Uint8Array): ParsedIndexBody => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 12 || String.fromCharCode(...bytes.subarray(0, 4)) !== 'DIRC') {
    throw new Error('Not a git index file');
  }
  const version = view.getUint32(4);
  if (version !== 2 && version !== 3 && version !== 4) {
    throw new Error(`Unsupported git index version ${version}`);
  }
  const entryCount = view.getUint32(8);

  const toHex = (offset: number): string => {
    let hex = '';
    for (let index = 0; index < 20; index += 1) {
      hex += (bytes[offset + index] ?? 0).toString(16).padStart(2, '0');
    }
    return hex;
  };

  const entries: RawIndexEntry[] = [];
  let offset = 12;
  let previousPath = '';
  for (let entry = 0; entry < entryCount; entry += 1) {
    if (offset + ENTRY_FIXED_BYTES_V2 > bytes.byteLength) {
      throw new Error('Truncated git index');
    }
    const flags = view.getUint16(offset + 60);
    const isExtended = (flags & EXTENDED_FLAG) !== 0;
    const pathStart = offset + ENTRY_FIXED_BYTES_V2 + (isExtended ? ENTRY_EXTENDED_BYTES_V2 : 0);
    const stage = (flags >> STAGE_SHIFT) & STAGE_MASK;
    const mode = view.getUint32(offset + 24);
    const sha = toHex(offset + 40);

    let path: string;
    if (version === 4) {
      // v4 prefix-compress the path against the previous entry: a varint of
      // how many leading bytes to keep, then the suffix, then NUL — no padding.
      const { value: keepBytes, next: suffixStart } = decodeOffsetVarint(bytes, pathStart);
      let pathEnd = suffixStart;
      while (pathEnd < bytes.byteLength && bytes[pathEnd] !== 0) {
        pathEnd += 1;
      }
      if (pathEnd >= bytes.byteLength) {
        throw new Error('Truncated git index');
      }
      path =
        previousPath.slice(0, keepBytes) +
        new TextDecoder().decode(bytes.subarray(suffixStart, pathEnd));
      previousPath = path;
      offset = pathEnd + 1;
    } else {
      const flaggedPathLength = flags & LONG_PATH_MASK;
      let pathEnd = pathStart;
      const pathLimit =
        flaggedPathLength === LONG_PATH_MASK
          ? bytes.byteLength
          : Math.min(bytes.byteLength, pathStart + flaggedPathLength);
      while (pathEnd < pathLimit && bytes[pathEnd] !== 0) {
        pathEnd += 1;
      }
      path = new TextDecoder().decode(bytes.subarray(pathStart, pathEnd));
      previousPath = path;

      // Entries are padded to a multiple of 8 bytes in length (not by absolute
      // file offset — the first entry starts at 12), with at least one NUL
      // terminating the path.
      const entryLength = pathEnd + 1 - offset;
      offset +=
        entryLength + ((ENTRY_ALIGNMENT - (entryLength % ENTRY_ALIGNMENT)) % ENTRY_ALIGNMENT);
    }
    entries.push({ path, sha, mode, stage });
  }

  // Extensions follow the entries and end before the trailing checksum.
  const extensionSignatures: string[] = [];
  const extensionsEnd = Math.max(offset, bytes.byteLength - TRAILING_HASH_BYTES);
  while (offset + 8 <= extensionsEnd) {
    extensionSignatures.push(String.fromCharCode(...bytes.subarray(offset, offset + 4)));
    offset += 8 + view.getUint32(offset + 4);
  }
  return { entries, extensionSignatures };
};

/** One stage-0 entry of a git index file. */
export interface ParsedIndexEntry {
  path: string;
  sha: string;
  mode: number;
}

const parseStageZeroEntries = (bytes: Uint8Array): ParsedIndexEntry[] =>
  parseIndexBody(bytes)
    .entries.filter((entry) => entry.stage === 0 && entry.path !== '')
    .map(({ path, sha, mode }) => ({ path, sha, mode }));

/**
 * Parses a git index file (formats v2/v3/v4) into a path → blob sha map of the
 * stage-0 entries. Throws on other versions or a truncated file.
 */
export const parseGitIndex = (bytes: Uint8Array): Map<string, string> =>
  new Map(parseStageZeroEntries(bytes).map((entry) => [entry.path, entry.sha]));

/** Index entries a browser file system cannot represent: symlinks and submodules. */
export interface UnsupportedIndexEntries {
  symlinkPaths: string[];
  gitlinkPaths: string[];
}

/** Finds the committed symlinks and submodules an index records. */
export const findUnsupportedIndexEntries = (bytes: Uint8Array): UnsupportedIndexEntries => {
  const symlinkPaths: string[] = [];
  const gitlinkPaths: string[] = [];
  for (const entry of parseStageZeroEntries(bytes)) {
    if (entry.mode === SYMLINK_MODE) {
      symlinkPaths.push(entry.path);
    } else if (entry.mode === GITLINK_MODE) {
      gitlinkPaths.push(entry.path);
    }
  }
  return { symlinkPaths, gitlinkPaths };
};

/**
 * Worktree paths to mount: all stages (conflicts keep 1-3), minus gitlinks and
 * sparse trees. Symlinks stay in — Chromium's file system access never hands
 * them over, but the warning surface keys off their presence in the index.
 */
export const parseTrackedWorktreePaths = (bytes: Uint8Array): string[] => {
  const paths = new Set<string>();
  for (const entry of parseIndexBody(bytes).entries) {
    if (entry.path === '' || entry.mode === GITLINK_MODE || entry.mode === TREE_MODE) {
      continue;
    }
    paths.add(entry.path);
  }
  return [...paths];
};

/**
 * A mandatory index extension this libgit2 build rejects outright: verified
 * that every lg2 command fails with "unsupported mandatory extension", so
 * there is nothing to fall back to — the caller must fail fast instead of
 * paying for a full walk that then dies.
 */
export type BlockingIndexExtension = 'link' | 'sdir';

/** Finds the split (`link`) or sparse (`sdir`) index marker, if present. */
export const findBlockingIndexExtension = (bytes: Uint8Array): BlockingIndexExtension | null => {
  const blocking = parseIndexBody(bytes).extensionSignatures.find(
    (signature): signature is BlockingIndexExtension =>
      signature === 'link' || signature === 'sdir',
  );
  return blocking ?? null;
};

/** The header of an inflated loose git object: `<type> <size>` before the first NUL. */
export interface ParsedLooseObjectHeader {
  type: string;
  size: number;
  contentStart: number;
}

/** Locates the content of an inflated loose object (`<type> <size>\0<content>`). */
export const parseLooseObjectHeader = (inflated: Uint8Array): ParsedLooseObjectHeader => {
  const nulIndex = inflated.indexOf(0);
  if (nulIndex < 0) {
    throw new Error('Malformed loose object: missing header terminator');
  }
  const header = new TextDecoder().decode(inflated.subarray(0, nulIndex));
  const match = header.match(/^(\S+) (\d+)$/);
  if (!match?.[1] || match[2] === undefined) {
    throw new Error(`Malformed loose object header: "${header}"`);
  }
  return { type: match[1], size: Number(match[2]), contentStart: nulIndex + 1 };
};
