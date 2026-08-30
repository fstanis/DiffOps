/** Prefix marking an in-app cross-reference to another changed file's card. */
export const NARRATION_LINK_PREFIX = '#narrate:';

export const buildNarrationPathHref = (path: string): string =>
  `${NARRATION_LINK_PREFIX}${encodeURIComponent(path)}`;

/** Decodes a narration cross-reference href back to its path, or null. */
export function parseNarrationPathHref(href: string): string | null {
  if (!href.startsWith(NARRATION_LINK_PREFIX)) {
    return null;
  }
  try {
    return decodeURIComponent(href.slice(NARRATION_LINK_PREFIX.length));
  } catch {
    return null;
  }
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Longest first so a path that prefixes another changed file's path cannot
// shadow it. The lookarounds keep matches whole-token: not inside a longer
// path or identifier, while still allowing sentence punctuation to follow.
const buildPathPattern = (paths: string[]): RegExp | null => {
  const distinct = [...new Set(paths.filter((path) => path.length > 0))].sort(
    (left, right) => right.length - left.length,
  );
  if (distinct.length === 0) {
    return null;
  }
  return new RegExp(
    `(?<![/\\w.-])(?:${distinct.map(escapeRegExp).join('|')})(?!(?:[/\\w]|\\.+\\w))`,
    'g',
  );
};

/**
 * Turns exact changed-file path mentions into narration cross-reference links,
 * leaving code blocks, inline code, and unmatched text untouched.
 */
export function linkifyNarrationPaths(markdown: string, paths: string[]): string {
  const pattern = buildPathPattern(paths);
  if (!pattern) {
    return markdown;
  }

  const linkifySegment = (segment: string): string =>
    segment.replace(pattern, (path) => `[${path}](${buildNarrationPathHref(path)})`);

  const linkifyLine = (line: string): string =>
    line
      .split(/(`[^`]*`)/g)
      .map((segment, index) => (index % 2 === 1 ? segment : linkifySegment(segment)))
      .join('');

  let isInsideFence = false;
  return markdown
    .split('\n')
    .map((line) => {
      const isFenceMarker = /^\s*(?:```|~~~)/.test(line);
      if (isInsideFence || isFenceMarker) {
        if (isFenceMarker) {
          isInsideFence = !isInsideFence;
        }
        return line;
      }
      return linkifyLine(line);
    })
    .join('\n');
}
