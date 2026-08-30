import { describe, expect, it } from 'bun:test';

import type { FileExplanation } from '../types/diff';
import { formatFileExplanation } from './explanationMarkdown';

const explanation = (overrides: Partial<FileExplanation> = {}): FileExplanation => ({
  fileSummary: 'Parses the sensor stream into beats.',
  symbols: [
    {
      name: 'parseStream',
      type: 'function',
      summary: 'Turns raw samples into beats.',
      contract: { input: 'samples: number[]', output: 'Beat[]' },
    },
    { name: 'MAX_GAP_MS', type: 'constant', summary: 'Longest gap still counted as one beat.' },
    { name: 'SessionEngine', type: 'class', summary: 'Owns the parsing pipeline.' },
  ],
  additionalFilesNeeded: [],
  ...overrides,
});

describe('formatFileExplanation', () => {
  it('renders the summary as a bare leading paragraph', () => {
    const markdown = formatFileExplanation(explanation({ symbols: [] }));

    expect(markdown).toBe('Parses the sensor stream into beats.');
  });

  it('renders symbols as one flat bulleted list in model order', () => {
    const markdown = formatFileExplanation(explanation());

    expect(markdown).toContain('- **`parseStream`** — Turns raw samples into beats.');
    expect(markdown).toContain('- **`MAX_GAP_MS`** — Longest gap still counted as one beat.');
    expect(markdown).toContain('- **`SessionEngine`** — Owns the parsing pipeline.');
    expect(markdown.indexOf('parseStream')).toBeLessThan(markdown.indexOf('MAX_GAP_MS'));
    expect(markdown.indexOf('MAX_GAP_MS')).toBeLessThan(markdown.indexOf('SessionEngine'));
  });

  it('renders contracts as separate nested In/Out sub-bullets', () => {
    const markdown = formatFileExplanation(explanation());

    expect(markdown).toContain('  - In: samples: number[]');
    expect(markdown).toContain('  - Out: Beat[]');
  });

  it('omits contract rows for symbols without a contract', () => {
    const markdown = formatFileExplanation(explanation());

    // Only the one contracted symbol produced In/Out rows.
    const inRows = markdown.split('\n').filter((line) => line.includes('- In:'));
    const outRows = markdown.split('\n').filter((line) => line.includes('- Out:'));
    expect(inRows).toHaveLength(1);
    expect(outRows).toHaveLength(1);
  });

  it('never renders the structural symbol type', () => {
    const markdown = formatFileExplanation(explanation());

    expect(markdown).not.toContain('function');
    expect(markdown).not.toContain('constant');
    expect(markdown).not.toContain('class');
  });
});
