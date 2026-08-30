import { isJsTsSourcePath, scanRelativeImportSpecifiers } from './importScanner';

// Probe order for an extensionless import: the specifier verbatim (explicit
// extensions), then extension completion, then index-file completion.
const EXTENSION_COMPLETIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'];

export interface ExplainCandidatesContext {
  sourcePath: string;
  source: string;
  /** Verifies one repository path exists; resolves false when it does not. */
  fileExists: (path: string) => Promise<boolean>;
}

/** Joins a relative specifier with the importing file's directory, resolving `.` and `..` segments. */
export function resolveImportPath(sourcePath: string, specifier: string): string {
  const segments = [...sourcePath.split('/').slice(0, -1), ...specifier.split('/')];
  const resolved: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }
  return resolved.join('/');
}

function buildProbePaths(extensionlessPath: string): string[] {
  return [
    extensionlessPath,
    ...EXTENSION_COMPLETIONS.map((extension) => extensionlessPath + extension),
    ...EXTENSION_COMPLETIONS.map((extension) => `${extensionlessPath}/index${extension}`),
  ];
}

/**
 * Resolves the file's relative imports to verified repository paths — extension
 * and index completion probed in order; unresolvable imports are absent.
 */
export async function resolveExplainCandidates(
  context: ExplainCandidatesContext,
): Promise<string[]> {
  if (!isJsTsSourcePath(context.sourcePath)) {
    return [];
  }

  const candidates: string[] = [];
  const probedPaths = new Set<string>();
  for (const specifier of scanRelativeImportSpecifiers(context.source)) {
    for (const probePath of buildProbePaths(resolveImportPath(context.sourcePath, specifier))) {
      if (probedPaths.has(probePath)) {
        continue;
      }
      probedPaths.add(probePath);
      if (await context.fileExists(probePath)) {
        candidates.push(probePath);
        break;
      }
    }
  }
  return candidates;
}
