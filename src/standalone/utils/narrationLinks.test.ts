import { describe, expect, it } from 'bun:test';

import {
  NARRATION_LINK_PREFIX,
  buildNarrationPathHref,
  linkifyNarrationPaths,
  parseNarrationPathHref,
} from './narrationLinks';

const PATHS = ['src/app.ts', 'src/app.test.ts', 'README.md'];

describe('linkifyNarrationPaths', () => {
  it('linkifies exact changed-path mentions', () => {
    const result = linkifyNarrationPaths('Start with src/app.ts, then README.md.', PATHS);

    expect(result).toContain(`[src/app.ts](${buildNarrationPathHref('src/app.ts')})`);
    expect(result).toContain(`[README.md](${buildNarrationPathHref('README.md')})`);
  });

  it('leaves non-changed paths and other text untouched', () => {
    const text = 'The config in src/config.ts and docs/spec.md matters.';

    expect(linkifyNarrationPaths(text, PATHS)).toBe(text);
  });

  it('does not linkify a path embedded in a longer path or identifier', () => {
    expect(linkifyNarrationPaths('see modules/src/app.ts boot', PATHS)).not.toContain('[');
    expect(linkifyNarrationPaths('the src/app.tsx rename', PATHS)).not.toContain('[');
    expect(linkifyNarrationPaths('my-src/app.ts loader', PATHS)).not.toContain('[');
  });

  it('prefers the longest matching path when one prefixes another', () => {
    const result = linkifyNarrationPaths('Read src/app.test.ts first.', PATHS);

    expect(result).toContain(`[src/app.test.ts](${buildNarrationPathHref('src/app.test.ts')})`);
    expect(result).not.toContain('[src/app.ts]');
  });

  it('keeps sentence punctuation adjacent to a path', () => {
    const result = linkifyNarrationPaths('Start with README.md.', PATHS);

    expect(result).toContain(`[README.md](${buildNarrationPathHref('README.md')}).`);
  });

  it('leaves fenced code blocks and inline code untouched', () => {
    const text = ['Run `src/app.ts` locally.', '```', 'import x from "src/app.ts";', '```'].join(
      '\n',
    );

    expect(linkifyNarrationPaths(text, PATHS)).toBe(text);
  });
});

describe('narration path hrefs', () => {
  it('round-trips paths through the href encoding', () => {
    for (const path of ['src/app.ts', 'a b/c(d).ts', 'ünicode/路径.ts']) {
      expect(parseNarrationPathHref(buildNarrationPathHref(path))).toBe(path);
    }
  });

  it('returns null for non-narration hrefs', () => {
    expect(parseNarrationPathHref('#anchor')).toBeNull();
    expect(parseNarrationPathHref('https://example.com')).toBeNull();
    expect(parseNarrationPathHref(`${NARRATION_LINK_PREFIX}%E0%A4%A`)).toBeNull();
  });
});
