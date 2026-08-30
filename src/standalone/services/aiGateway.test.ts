import { beforeEach, describe, expect, it, vi } from 'bun:test';

import type { FileExplanation, Narration } from '../../types/diff';

// Mock the AI SDK so these tests never reach the network.
vi.mock('ai', () => ({
  generateObject: vi.fn(),
  jsonSchema: (schema: unknown) => schema,
  createGateway: vi.fn((options: { apiKey: string }) => ({
    languageModel: (id: string) => ({ id, apiKey: options.apiKey }),
  })),
}));
const { createGateway, generateObject } = await import('ai');
const { generateFileExplanation, generateNarration } = await import('./aiGateway');

interface GenerateCall {
  model: { id: string; apiKey: string };
  providerOptions?: { gateway: { only: string[] } };
  schema: {
    required: string[];
    properties: { symbols: { items: { required: string[] } } };
  };
  abortSignal?: AbortSignal;
}

const lastCall = (): GenerateCall =>
  vi.mocked(generateObject).mock.calls[0]?.[0] as unknown as GenerateCall;

const mockObject = (object: unknown) => {
  vi.mocked(generateObject).mockResolvedValue({ object } as never);
};

const explanation = (overrides: Partial<FileExplanation> = {}) => ({
  fileSummary: 'Runs the app.',
  symbols: [{ name: 'run', type: 'function', summary: 'Runs it.', isPublic: true }],
  ...overrides,
});

describe('generateFileExplanation', () => {
  beforeEach(() => {
    vi.mocked(generateObject).mockReset();
    vi.mocked(createGateway).mockClear();
  });

  it('authenticates the model with the caller-supplied key', async () => {
    mockObject(explanation({ additionalFilesNeeded: [] }));

    await generateFileExplanation({
      prompt: 'p',
      candidateFiles: ['src/a.ts'],
      model: 'anthropic/claude-sonnet-5',
      apiKey: 'user-key',
    });

    expect(createGateway).toHaveBeenCalledWith({ apiKey: 'user-key' });
    expect(lastCall().model).toEqual({ id: 'anthropic/claude-sonnet-5', apiKey: 'user-key' });
  });

  it('pins Anthropic models to the Vertex deployment and leaves others unrouted', async () => {
    mockObject(explanation({ additionalFilesNeeded: [] }));
    await generateFileExplanation({
      prompt: 'p',
      candidateFiles: [],
      model: 'anthropic/claude-sonnet-5',
      apiKey: 'k',
    });
    expect(lastCall().providerOptions).toEqual({ gateway: { only: ['vertexAnthropic'] } });

    vi.mocked(generateObject).mockReset();
    mockObject(explanation());
    await generateFileExplanation({
      prompt: 'p',
      candidateFiles: [],
      model: 'openai/gpt-5.6-sol',
      apiKey: 'k',
    });
    expect(lastCall().providerOptions).toBeUndefined();
  });

  it('uses the reduced schema and reports no requests when nothing is offered', async () => {
    mockObject(explanation());

    const result = await generateFileExplanation({
      prompt: 'p',
      candidateFiles: [],
      model: 'anthropic/claude-sonnet-5',
      apiKey: 'k',
    });

    expect(lastCall().schema.required).toEqual(['fileSummary', 'symbols']);
    expect(result.additionalFilesNeeded).toEqual([]);
  });

  it('requires isPublic on every symbol', async () => {
    mockObject(explanation());

    await generateFileExplanation({
      prompt: 'p',
      candidateFiles: [],
      model: 'anthropic/claude-sonnet-5',
      apiKey: 'k',
    });

    expect(lastCall().schema.properties.symbols.items.required).toContain('isPublic');
  });

  it('uses the request-capable schema when candidates are offered', async () => {
    mockObject(explanation({ additionalFilesNeeded: [] }));

    await generateFileExplanation({
      prompt: 'p',
      candidateFiles: ['src/a.ts'],
      model: 'anthropic/claude-sonnet-5',
      apiKey: 'k',
    });

    expect(lastCall().schema.required).toEqual(['fileSummary', 'symbols', 'additionalFilesNeeded']);
  });

  it('drops requested files that were never offered, keeping model order', async () => {
    mockObject(
      explanation({
        additionalFilesNeeded: ['src/b.ts', 'src/hallucinated.ts', 'src/a.ts', 'src/b.ts'],
      }),
    );

    const result = await generateFileExplanation({
      prompt: 'p',
      candidateFiles: ['src/a.ts', 'src/b.ts'],
      model: 'anthropic/claude-sonnet-5',
      apiKey: 'k',
    });

    expect(result.additionalFilesNeeded).toEqual(['src/b.ts', 'src/a.ts']);
  });

  it('forwards the abort signal', async () => {
    mockObject(explanation());
    const controller = new AbortController();

    await generateFileExplanation({
      prompt: 'p',
      candidateFiles: [],
      model: 'anthropic/claude-sonnet-5',
      apiKey: 'k',
      signal: controller.signal,
    });

    expect(lastCall().abortSignal).toBe(controller.signal);
  });
});

describe('generateNarration', () => {
  beforeEach(() => {
    vi.mocked(generateObject).mockReset();
  });

  const narrate = (cards: Narration['cards'], paths: string[]) => {
    mockObject({ intro: 'Intro.', cards, epilogue: 'Epilogue.' });
    return generateNarration({ prompt: 'p', paths, model: 'anthropic/claude-opus-5', apiKey: 'k' });
  };

  it('keeps the model order for a complete card list', async () => {
    const result = await narrate(
      [
        { path: 'b.ts', narrative: 'B.' },
        { path: 'a.ts', narrative: 'A.' },
      ],
      ['a.ts', 'b.ts'],
    );

    expect(result.cards.map((card) => card.path)).toEqual(['b.ts', 'a.ts']);
    expect(result.intro).toBe('Intro.');
    expect(result.epilogue).toBe('Epilogue.');
  });

  it('drops unknown and duplicate paths and appends missing files in prompt order', async () => {
    const result = await narrate(
      [
        { path: 'b.ts', narrative: 'B.' },
        { path: 'ghost.ts', narrative: 'Not in the changeset.' },
        { path: 'b.ts', narrative: 'B again.' },
      ],
      ['a.ts', 'b.ts', 'c.ts'],
    );

    expect(result.cards).toEqual([
      { path: 'b.ts', narrative: 'B.' },
      { path: 'a.ts', narrative: '' },
      { path: 'c.ts', narrative: '' },
    ]);
  });
});
