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

/** One stage-0 entry of a git index file. */
export interface ParsedIndexEntry {
  path: string;
  sha: string;
  mode: number;
}

/**
 * Parses a git index file (formats v2/v3) into its stage-0 entries, carrying
 * each entry's mode. Throws on other versions or a truncated file.
 */
const parseGitIndexEntries = (bytes: Uint8Array): ParsedIndexEntry[] => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 12 || String.fromCharCode(...bytes.subarray(0, 4)) !== 'DIRC') {
    throw new Error('Not a git index file');
  }
  const version = view.getUint32(4);
  if (version !== 2 && version !== 3) {
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

  const entries: ParsedIndexEntry[] = [];
  let offset = 12;
  for (let entry = 0; entry < entryCount; entry += 1) {
    if (offset + ENTRY_FIXED_BYTES_V2 > bytes.byteLength) {
      throw new Error('Truncated git index');
    }
    const flags = view.getUint16(offset + 60);
    const isExtended = (flags & EXTENDED_FLAG) !== 0;
    const pathStart = offset + ENTRY_FIXED_BYTES_V2 + (isExtended ? ENTRY_EXTENDED_BYTES_V2 : 0);

    const flaggedPathLength = flags & LONG_PATH_MASK;
    let pathEnd = pathStart;
    const pathLimit =
      flaggedPathLength === LONG_PATH_MASK
        ? bytes.byteLength
        : Math.min(bytes.byteLength, pathStart + flaggedPathLength);
    while (pathEnd < pathLimit && bytes[pathEnd] !== 0) {
      pathEnd += 1;
    }

    const stage = (flags >> STAGE_SHIFT) & STAGE_MASK;
    const path = new TextDecoder().decode(bytes.subarray(pathStart, pathEnd));
    if (stage === 0 && path) {
      entries.push({ path, sha: toHex(offset + 40), mode: view.getUint32(offset + 24) });
    }

    // Entries are padded to a multiple of 8 bytes in length (not by absolute
    // file offset — the first entry starts at 12), with at least one NUL
    // terminating the path.
    const entryLength = pathEnd + 1 - offset;
    offset += entryLength + ((ENTRY_ALIGNMENT - (entryLength % ENTRY_ALIGNMENT)) % ENTRY_ALIGNMENT);
  }
  return entries;
};

/**
 * Parses a git index file (formats v2/v3) into a path → blob sha map of the
 * stage-0 entries. Throws on other versions or a truncated file.
 */
export const parseGitIndex = (bytes: Uint8Array): Map<string, string> =>
  new Map(parseGitIndexEntries(bytes).map((entry) => [entry.path, entry.sha]));

/** Index entries a browser file system cannot represent: symlinks and submodules. */
export interface UnsupportedIndexEntries {
  symlinkPaths: string[];
  gitlinkPaths: string[];
}

/** Finds the committed symlinks and submodules an index records. */
export const findUnsupportedIndexEntries = (bytes: Uint8Array): UnsupportedIndexEntries => {
  const symlinkPaths: string[] = [];
  const gitlinkPaths: string[] = [];
  for (const entry of parseGitIndexEntries(bytes)) {
    if (entry.mode === SYMLINK_MODE) {
      symlinkPaths.push(entry.path);
    } else if (entry.mode === GITLINK_MODE) {
      gitlinkPaths.push(entry.path);
    }
  }
  return { symlinkPaths, gitlinkPaths };
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
