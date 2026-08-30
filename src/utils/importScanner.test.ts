import { describe, expect, it } from 'bun:test';

import { isJsTsSourcePath, scanRelativeImportSpecifiers } from './importScanner';

describe('isJsTsSourcePath', () => {
  it.each(['a.ts', 'a.tsx', 'a.js', 'a.jsx', 'a.mjs', 'a.cjs', 'a.mts', 'a.cts', 'SRC/A.TS'])(
    'accepts %s',
    (path) => {
      expect(isJsTsSourcePath(path)).toBe(true);
    },
  );

  it.each(['a.py', 'a.rs', 'README.md', 'Makefile', 'src/app.css'])('rejects %s', (path) => {
    expect(isJsTsSourcePath(path)).toBe(false);
  });
});

describe('scanRelativeImportSpecifiers', () => {
  it('collects static imports, re-exports, require, and dynamic imports', () => {
    const source = [
      "import { helper } from './helper';",
      "import sideEffect from '../lib/side-effect';",
      "import '../polyfills';",
      "export { thing } from './things';",
      "export * from '../lib/star';",
      "const util = require('./util');",
      "const lazy = import('./lazy');",
    ].join('\n');

    expect(scanRelativeImportSpecifiers(source)).toEqual([
      './helper',
      '../lib/side-effect',
      '../polyfills',
      './things',
      '../lib/star',
      './util',
      './lazy',
    ]);
  });

  it('matches multi-line import statements', () => {
    const source = ['import {', '  first,', '  second,', "} from './multi';"].join('\n');

    expect(scanRelativeImportSpecifiers(source)).toEqual(['./multi']);
  });

  it('keeps only the first appearance of a duplicate specifier', () => {
    const source = ["import { a } from './dup';", "import { b } from './dup';"].join('\n');

    expect(scanRelativeImportSpecifiers(source)).toEqual(['./dup']);
  });

  it('excludes bare package names and path aliases', () => {
    const source = [
      "import { useState } from 'react';",
      "import { x } from '@/aliases/x';",
      "import { y } from '~/home/y';",
      "import { z } from 'lodash/z';",
    ].join('\n');

    expect(scanRelativeImportSpecifiers(source)).toEqual([]);
  });

  it('returns nothing for sources without imports', () => {
    expect(scanRelativeImportSpecifiers('const x = 1;\nconsole.log(x);')).toEqual([]);
    expect(scanRelativeImportSpecifiers('')).toEqual([]);
  });
});
