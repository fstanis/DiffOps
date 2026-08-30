import type { DiffChunk, DiffFile, DiffLine } from '../types/diff.js';

import { isGeneratedFile } from './generated-file-check.js';

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

/** Splits a full unified diff (git or plain patch format) into per-file entries. */
export function parseUnifiedDiff(diffText: string): DiffFile[] {
  const files: DiffFile[] = [];
  const fileBlocks = diffText.split(/^diff --git /m).slice(1);

  if (fileBlocks.length > 0) {
    for (const fileBlock of fileBlocks) {
      const block = `diff --git ${fileBlock}`;
      const file = parseFileBlock(block);
      if (file) {
        files.push(file);
      }
    }

    return files;
  }

  for (const fileBlock of splitPlainUnifiedDiff(diffText)) {
    const file = parseFileBlock(fileBlock, 'plain');
    if (file) {
      files.push(file);
    }
  }

  return files;
}

function splitPlainUnifiedDiff(diffText: string): string[] {
  const lines = diffText.split(/\r?\n/);
  const blocks: string[] = [];
  let blockStart: number | null = null;
  let remainingOldLines = 0;
  let remainingNewLines = 0;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? '';

    if (blockStart !== null && line.startsWith('@@')) {
      const match = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (match) {
        remainingOldLines = parseInt(match[2] ?? '1');
        remainingNewLines = parseInt(match[4] ?? '1');
      }
      continue;
    }

    if (blockStart !== null && (remainingOldLines > 0 || remainingNewLines > 0)) {
      if (line.startsWith('\\')) {
        continue;
      }
      if (line.startsWith('+')) {
        remainingNewLines--;
      } else if (line.startsWith('-')) {
        remainingOldLines--;
      } else if (line.startsWith(' ')) {
        remainingOldLines--;
        remainingNewLines--;
      }
      continue;
    }

    if (line.startsWith('--- ') && lines[index + 1]?.startsWith('+++ ')) {
      if (blockStart !== null) {
        blocks.push(lines.slice(blockStart, index).join('\n'));
      }
      blockStart = index;
    }
  }

  if (blockStart !== null) {
    blocks.push(lines.slice(blockStart).join('\n'));
  }

  return blocks;
}

interface GitPathOptions {
  stripGitPrefix?: boolean;
}

function decodeGitPath(
  rawPath: string | undefined,
  { stripGitPrefix = true }: GitPathOptions = {},
): string | undefined {
  if (typeof rawPath !== 'string') {
    return undefined;
  }

  const tabIndex = rawPath.indexOf('\t');
  const pathWithoutTimestamp = tabIndex === -1 ? rawPath : rawPath.slice(0, tabIndex);
  const trimmed =
    pathWithoutTimestamp.startsWith('"') && pathWithoutTimestamp.endsWith('"')
      ? pathWithoutTimestamp.slice(1, -1)
      : pathWithoutTimestamp;

  const gitPrefixes = ['a/', 'b/', 'c/', 'i/', 'w/'];
  let withoutPrefix = trimmed;
  if (stripGitPrefix) {
    for (const prefix of gitPrefixes) {
      if (withoutPrefix.startsWith(prefix)) {
        withoutPrefix = withoutPrefix.slice(prefix.length);
        break;
      }
    }
  }

  if (withoutPrefix === '/dev/null') {
    return undefined;
  }

  const bytes: number[] = [];
  for (let i = 0; i < withoutPrefix.length; i++) {
    const char = withoutPrefix[i];

    if (char === '\\' && i + 1 < withoutPrefix.length) {
      const next = withoutPrefix[i + 1];

      if (next !== undefined && /[0-7]/.test(next)) {
        let octal = next;
        let read = 1;

        while (read < 3 && i + 1 + read < withoutPrefix.length) {
          const candidate = withoutPrefix[i + 1 + read];
          if (candidate === undefined || !/[0-7]/.test(candidate)) {
            break;
          }
          octal += candidate;
          read++;
        }

        bytes.push(parseInt(octal, 8));
        i += read;
        continue;
      }

      switch (next) {
        case 't':
          bytes.push(0x09);
          break;
        case 'n':
          bytes.push(0x0a);
          break;
        case 'r':
          bytes.push(0x0d);
          break;
        case 'b':
          bytes.push(0x08);
          break;
        case 'f':
          bytes.push(0x0c);
          break;
        case 'v':
          bytes.push(0x0b);
          break;
        case 'a':
          bytes.push(0x07);
          break;
        case '\\':
          bytes.push(0x5c);
          break;
        case '"':
          bytes.push(0x22);
          break;
        case ' ':
          bytes.push(0x20);
          break;
        default:
          bytes.push(...utf8Encoder.encode(next));
          break;
      }
      i++;
      continue;
    }

    bytes.push(...utf8Encoder.encode(char));
  }

  return utf8Decoder.decode(Uint8Array.from(bytes));
}

function extractPathFromLine(
  line: string | undefined,
  prefix: string,
  { stripGitPrefix = true }: GitPathOptions = {},
): string | undefined {
  if (!line?.startsWith(prefix)) {
    return undefined;
  }

  return decodeGitPath(line.slice(prefix.length), { stripGitPrefix });
}

function parseDiffHeaderPaths(
  headerLine: string,
): { oldPath: string | undefined; newPath: string | undefined } | null {
  if (!headerLine.startsWith('diff --git ')) {
    return null;
  }

  const raw = headerLine.slice('diff --git '.length);
  const segments: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    const prevChar = i > 0 ? raw[i - 1] : null;

    if (char === '"' && prevChar !== '\\') {
      inQuotes = !inQuotes;
      current += char;
      continue;
    }

    if (char === ' ' && !inQuotes && prevChar !== '\\') {
      if (current) {
        segments.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (current) {
    segments.push(current);
  }

  if (segments.length !== 2) {
    return null;
  }

  const [rawOldPath, rawNewPath] = segments;
  return {
    oldPath: decodeGitPath(rawOldPath),
    newPath: decodeGitPath(rawNewPath),
  };
}

/** Parses one `diff --git` or plain-patch file block into a DiffFile, or null when no path can be recovered. */
function parseFileBlock(block: string, format: 'git' | 'plain' = 'git'): DiffFile | null {
  const lines = block.split('\n');
  const headerLine = lines[0] ?? '';
  const headerPaths = parseDiffHeaderPaths(headerLine);

  const minusLine = lines.find((line) => line.startsWith('--- '));
  const plusLine = lines.find((line) => line.startsWith('+++ '));
  const renameFromLine = lines.find((line) => line.startsWith('rename from '));
  const renameToLine = lines.find((line) => line.startsWith('rename to '));
  // git prints "Binary files a/x and b/x differ" (or a "GIT binary patch"
  // section under --binary) instead of hunks for non-text content.
  const isBinary =
    format === 'git' &&
    lines.some((line) => line.startsWith('Binary files ') || line.startsWith('GIT binary patch'));

  const stripGitPrefix = format !== 'plain';
  const plusPath = extractPathFromLine(plusLine, '+++ ', { stripGitPrefix });
  const minusPath = extractPathFromLine(minusLine, '--- ', { stripGitPrefix });
  const renameFromPath = extractPathFromLine(renameFromLine, 'rename from ');
  const renameToPath = extractPathFromLine(renameToLine, 'rename to ');
  const parsedNewPath = renameToPath ?? plusPath ?? headerPaths?.newPath;
  const parsedOldPath = renameFromPath ?? minusPath ?? headerPaths?.oldPath;
  const newPath = parsedNewPath ?? parsedOldPath;
  const oldPath = parsedOldPath ?? newPath;

  if (!newPath) {
    return null;
  }

  const path = newPath;

  let status: DiffFile['status'] = 'modified';

  const newFileMode = lines.find((line) => line.startsWith('new file mode'));
  const deletedFileMode = lines.find((line) => line.startsWith('deleted file mode'));

  if (newFileMode || minusLine?.includes('/dev/null')) {
    status = 'added';
  } else if (deletedFileMode || plusLine?.includes('/dev/null')) {
    status = 'deleted';
  } else if (format !== 'plain' && oldPath !== newPath) {
    status = 'renamed';
  }

  const baseFile = {
    path,
    oldPath: status === 'renamed' && oldPath !== newPath ? oldPath : undefined,
    status,
  };

  const chunks = parseChunks(lines);

  const { additions, deletions } = countLinesFromChunks(chunks);
  return {
    ...baseFile,
    additions,
    deletions,
    chunks,
    isGenerated: isGeneratedFile(path).isGenerated,
    isBinary,
  };
}

/** Counts added and deleted lines across every chunk of a parsed file. */
function countLinesFromChunks(chunks: DiffChunk[]): {
  additions: number;
  deletions: number;
} {
  let additions = 0;
  let deletions = 0;
  for (const chunk of chunks) {
    for (const line of chunk.lines) {
      if (line.type === 'add') {
        additions++;
      } else if (line.type === 'delete') {
        deletions++;
      }
    }
  }
  return { additions, deletions };
}

const lineTypeByPrefix: Record<string, DiffLine['type']> = {
  '+': 'add',
  '-': 'delete',
  ' ': 'normal',
};

function parseChunks(lines: string[]): DiffChunk[] {
  const chunks: DiffChunk[] = [];
  let currentChunk: DiffChunk | null = null;
  let oldLineNum = 0;
  let newLineNum = 0;

  for (const line of lines) {
    if (line.startsWith('@@')) {
      if (currentChunk) {
        chunks.push(currentChunk);
      }

      const match = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)/);
      if (match) {
        const oldStart = parseInt(match[1] ?? '0');
        const oldLines = parseInt(match[2] || '1');
        const newStart = parseInt(match[3] ?? '0');
        const newLines = parseInt(match[4] || '1');

        oldLineNum = oldStart;
        newLineNum = newStart;

        currentChunk = {
          header: line,
          oldStart,
          oldLines,
          newStart,
          newLines,
          lines: [],
        };
      }
    } else if (
      currentChunk &&
      (line.startsWith('+') || line.startsWith('-') || line.startsWith(' '))
    ) {
      const type = lineTypeByPrefix[line.charAt(0)] ?? 'normal';

      const diffLine: DiffLine = {
        type,
        content: line.slice(1),
        oldLineNumber: type !== 'add' ? oldLineNum : undefined,
        newLineNumber: type !== 'delete' ? newLineNum : undefined,
      };

      currentChunk.lines.push(diffLine);

      if (type !== 'add') {
        oldLineNum++;
      }
      if (type !== 'delete') {
        newLineNum++;
      }
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk);
  }

  return chunks;
}
