// Regex-based import scanner for the JS/TS family: static imports, re-exports,
// require calls, and dynamic imports. Relative specifiers only — bare package
// names and path aliases are not resolvable against the repository, so the
// candidate list never contains them.

const IMPORT_SPECIFIER_PATTERNS: RegExp[] = [
  /\bimport\s+[^;'"`]*?from\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bexport\s+[^;'"`]*?from\s*['"]([^'"]+)['"]/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

const isRelativeSpecifier = (specifier: string): boolean =>
  specifier.startsWith('./') || specifier.startsWith('../');

const JS_TS_EXTENSIONS = new Set(['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts']);

/** Whether a path belongs to the JS/TS family the import scanner understands. */
export function isJsTsSourcePath(path: string): boolean {
  const extension = path.includes('.') ? (path.split('.').pop() ?? '').toLowerCase() : '';
  return JS_TS_EXTENSIONS.has(extension);
}

/** Lists the unique relative import specifiers of a source, in first-appearance order. */
export function scanRelativeImportSpecifiers(source: string): string[] {
  const seen = new Set<string>();
  const specifiers: string[] = [];
  for (const pattern of IMPORT_SPECIFIER_PATTERNS) {
    pattern.lastIndex = 0;
    let match = pattern.exec(source);
    while (match !== null) {
      const specifier = match[1];
      if (specifier !== undefined && isRelativeSpecifier(specifier) && !seen.has(specifier)) {
        seen.add(specifier);
        specifiers.push(specifier);
      }
      match = pattern.exec(source);
    }
  }
  return specifiers;
}
