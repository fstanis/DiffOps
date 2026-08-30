import { describe, expect, it } from 'bun:test';

import { resolveExplainCandidates, resolveImportPath } from './explainCandidates';

describe('resolveImportPath', () => {
  it('joins the specifier with the importing file directory', () => {
    expect(resolveImportPath('src/app/main.ts', './helper')).toBe('src/app/helper');
    expect(resolveImportPath('src/app/main.ts', './util/format')).toBe('src/app/util/format');
  });

  it('resolves parent segments', () => {
    expect(resolveImportPath('src/app/main.ts', '../lib/helper')).toBe('src/lib/helper');
    expect(resolveImportPath('src/app/main.ts', '../../root')).toBe('root');
  });

  it('keeps explicitly extended specifiers verbatim', () => {
    expect(resolveImportPath('src/app/main.ts', './helper.js')).toBe('src/app/helper.js');
  });
});

describe('resolveExplainCandidates', () => {
  const existingPaths = (paths: string[]) => {
    const set = new Set(paths);
    return async (path: string) => set.has(path);
  };

  const resolve = (source: string, exists: (path: string) => Promise<boolean>) =>
    resolveExplainCandidates({
      sourcePath: 'src/app/main.ts',
      source,
      fileExists: exists,
    });

  it('completes extensionless specifiers with the first existing extension', async () => {
    const candidates = await resolve(
      "import { x } from './helper';",
      existingPaths(['src/app/helper.ts']),
    );

    expect(candidates).toEqual(['src/app/helper.ts']);
  });

  it('probes extensions in order before index completion', async () => {
    const candidates = await resolve(
      "import { x } from './mod';",
      existingPaths(['src/app/mod/index.tsx']),
    );

    expect(candidates).toEqual(['src/app/mod/index.tsx']);
  });

  it('keeps specifiers whose explicit extension already exists', async () => {
    const candidates = await resolve(
      "import { x } from './helper.js';",
      existingPaths(['src/app/helper.js']),
    );

    expect(candidates).toEqual(['src/app/helper.js']);
  });

  it('drops specifiers that resolve to no existing path', async () => {
    const candidates = await resolve(
      ["import { x } from './helper';", "import { y } from './missing';"].join('\n'),
      existingPaths(['src/app/helper.ts']),
    );

    expect(candidates).toEqual(['src/app/helper.ts']);
  });

  it('lists a file once when two specifiers resolve to the same path', async () => {
    const candidates = await resolve(
      ["import { x } from './helper';", "import { y } from '../app/helper';"].join('\n'),
      existingPaths(['src/app/helper.ts']),
    );

    expect(candidates).toEqual(['src/app/helper.ts']);
  });

  it('returns no candidates for non-JS/TS sources', async () => {
    const candidates = await resolveExplainCandidates({
      sourcePath: 'scripts/build.py',
      source: "import './helper'",
      fileExists: existingPaths(['scripts/helper.py']),
    });

    expect(candidates).toEqual([]);
  });

  it('returns no candidates for bare-package imports', async () => {
    const candidates = await resolve("import { x } from 'react';", existingPaths(['react']));

    expect(candidates).toEqual([]);
  });
});
