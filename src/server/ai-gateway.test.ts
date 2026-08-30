import { describe, it, expect, vi, beforeEach, afterEach } from 'bun:test';

import { handleAiGatewayRequest, isAiGatewayPath } from './ai-gateway.js';
import { EXPLAIN_PROMPT_MAX_BYTES } from '../utils/explainPrompt.js';
import { NARRATE_PROMPT_MAX_BYTES } from '../utils/narratePrompt.js';

// Mock the AI SDK so gateway tests never reach the network
vi.mock('ai', () => ({
  generateText: vi.fn(),
  generateObject: vi.fn(),
}));
const { generateText, generateObject } = await import('ai');

const ORIGIN = 'http://localhost:4173';

const gatewayRequest = (path: string, init: { method?: string; body?: unknown } = {}): Request =>
  new Request(`${ORIGIN}${path}`, {
    method: init.method ?? 'GET',
    ...(init.body === undefined
      ? {}
      : { body: JSON.stringify(init.body), headers: { 'Content-Type': 'application/json' } }),
  });

describe('AI gateway handler', () => {
  const originalApiKey = process.env.AI_GATEWAY_API_KEY;
  const originalModel = process.env.DIFFOPS_EXPLAIN_MODEL;
  const originalNarrateModel = process.env.DIFFOPS_NARRATE_MODEL;

  beforeEach(() => {
    vi.mocked(generateText).mockReset();
    vi.mocked(generateObject).mockReset();
    process.env.AI_GATEWAY_API_KEY = 'test-key';
  });

  afterEach(() => {
    if (originalApiKey === undefined) {
      delete process.env.AI_GATEWAY_API_KEY;
    } else {
      process.env.AI_GATEWAY_API_KEY = originalApiKey;
    }
    if (originalModel === undefined) {
      delete process.env.DIFFOPS_EXPLAIN_MODEL;
    } else {
      process.env.DIFFOPS_EXPLAIN_MODEL = originalModel;
    }
    if (originalNarrateModel === undefined) {
      delete process.env.DIFFOPS_NARRATE_MODEL;
    } else {
      process.env.DIFFOPS_NARRATE_MODEL = originalNarrateModel;
    }
  });

  it('reports disabled with the default models when no API key is set', async () => {
    delete process.env.AI_GATEWAY_API_KEY;

    const response = await handleAiGatewayRequest(gatewayRequest('/ai-gateway/status'));

    expect(response).not.toBeNull();
    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual({
      enabled: false,
      model: 'anthropic/claude-sonnet-5',
      narrateModel: 'anthropic/claude-opus-5',
    });
  });

  it('reports enabled with the model overrides', async () => {
    process.env.DIFFOPS_EXPLAIN_MODEL = 'openai/gpt-5.1';
    process.env.DIFFOPS_NARRATE_MODEL = 'anthropic/claude-opus-5.5';

    const response = await handleAiGatewayRequest(gatewayRequest('/ai-gateway/status'));

    expect(response).not.toBeNull();
    await expect(response?.json()).resolves.toEqual({
      enabled: true,
      model: 'openai/gpt-5.1',
      narrateModel: 'anthropic/claude-opus-5.5',
    });
  });

  it('returns the generated explanation for the prompt', async () => {
    vi.mocked(generateText).mockResolvedValue({ text: 'It refactors the parser.' } as never);

    const response = await handleAiGatewayRequest(
      gatewayRequest('/ai-gateway/explain', { method: 'POST', body: { prompt: 'Explain this.' } }),
    );

    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual({ explanation: 'It refactors the parser.' });
    expect(vi.mocked(generateText)).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'anthropic/claude-sonnet-5', prompt: 'Explain this.' }),
    );
  });

  it('routes anthropic model overrides only through the Vertex backend', async () => {
    process.env.DIFFOPS_EXPLAIN_MODEL = 'anthropic/claude-opus-5';
    vi.mocked(generateText).mockResolvedValue({ text: 'ok' } as never);

    const response = await handleAiGatewayRequest(
      gatewayRequest('/ai-gateway/explain', { method: 'POST', body: { prompt: 'Explain this.' } }),
    );

    expect(response?.status).toBe(200);
    expect(vi.mocked(generateText)).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'anthropic/claude-opus-5',
        providerOptions: { gateway: { only: ['vertexAnthropic'] } },
      }),
    );
  });

  it('rejects explain requests without a configured API key', async () => {
    delete process.env.AI_GATEWAY_API_KEY;

    const response = await handleAiGatewayRequest(
      gatewayRequest('/ai-gateway/explain', { method: 'POST', body: { prompt: 'Explain this.' } }),
    );

    expect(response?.status).toBe(503);
    await expect(response?.json()).resolves.toHaveProperty('error');
    expect(vi.mocked(generateText)).not.toHaveBeenCalled();
  });

  it('rejects invalid explain payloads', async () => {
    for (const body of [{}, { prompt: 42 }, { prompt: '   ' }]) {
      const response = await handleAiGatewayRequest(
        gatewayRequest('/ai-gateway/explain', { method: 'POST', body }),
      );

      expect(response?.status).toBe(400);
    }
    expect(vi.mocked(generateText)).not.toHaveBeenCalled();
  });

  it('rejects explain prompts over the size limit', async () => {
    const response = await handleAiGatewayRequest(
      gatewayRequest('/ai-gateway/explain', {
        method: 'POST',
        body: { prompt: 'x'.repeat(EXPLAIN_PROMPT_MAX_BYTES + 1) },
      }),
    );

    expect(response?.status).toBe(413);
    await expect(response?.json()).resolves.toHaveProperty('error');
    expect(vi.mocked(generateText)).not.toHaveBeenCalled();
  });

  it('surfaces gateway failures as structured errors', async () => {
    vi.mocked(generateText).mockRejectedValueOnce(new Error('rate limited'));

    const response = await handleAiGatewayRequest(
      gatewayRequest('/ai-gateway/explain', { method: 'POST', body: { prompt: 'Explain this.' } }),
    );

    expect(response?.status).toBe(502);
    await expect(response?.json()).resolves.toEqual({ error: 'Failed to generate explanation' });
  });

  describe('narrate route', () => {
    const narrateRequest = (body: unknown) =>
      gatewayRequest('/ai-gateway/narrate', { method: 'POST', body });

    const mockNarration = (object: unknown) =>
      vi.mocked(generateObject).mockResolvedValue({ object } as never);

    it('returns the structured narration for the prompt', async () => {
      mockNarration({
        intro: 'Adds a config-driven cache.',
        cards: [
          { path: 'src/config.ts', narrative: 'Read first.' },
          { path: 'src/cache.ts', narrative: 'The consumer.' },
        ],
        epilogue: 'Verify cache invalidation.',
      });

      const response = await handleAiGatewayRequest(
        narrateRequest({ prompt: 'Narrate.', paths: ['src/cache.ts', 'src/config.ts'] }),
      );

      expect(response?.status).toBe(200);
      await expect(response?.json()).resolves.toEqual({
        narration: {
          intro: 'Adds a config-driven cache.',
          cards: [
            { path: 'src/config.ts', narrative: 'Read first.' },
            { path: 'src/cache.ts', narrative: 'The consumer.' },
          ],
          epilogue: 'Verify cache invalidation.',
        },
      });
      expect(vi.mocked(generateObject)).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'anthropic/claude-opus-5',
          prompt: 'Narrate.',
          providerOptions: { gateway: { only: ['vertexAnthropic'] } },
        }),
      );
    });

    it('completes the permutation: unknown paths dropped, missing appended in prompt order', async () => {
      mockNarration({
        intro: 'intro',
        cards: [
          { path: 'src/cache.ts', narrative: 'consumer' },
          { path: 'made/up/path.ts', narrative: 'unknown file' },
        ],
        epilogue: 'epilogue',
      });

      const response = await handleAiGatewayRequest(
        narrateRequest({
          prompt: 'Narrate.',
          paths: ['src/config.ts', 'src/cache.ts', 'README.md'],
        }),
      );

      expect(response).not.toBeNull();
      expect(response?.status).toBe(200);
      const payload = (await response!.json()) as {
        narration: { cards: Array<{ path: string; narrative: string }> };
      };
      const { narration } = payload;
      expect(narration.cards.map((card) => card.path)).toEqual([
        'src/cache.ts',
        'src/config.ts',
        'README.md',
      ]);
      expect(narration.cards[1]?.narrative).toBe('');
      expect(narration.cards[2]?.narrative).toBe('');
    });

    it('uses the DIFFOPS_NARRATE_MODEL override and skips vertex pinning off anthropic', async () => {
      process.env.DIFFOPS_NARRATE_MODEL = 'openai/gpt-5.1';
      mockNarration({ intro: 'i', cards: [], epilogue: 'e' });

      const response = await handleAiGatewayRequest(
        narrateRequest({ prompt: 'Narrate.', paths: ['a.ts'] }),
      );

      expect(response?.status).toBe(200);
      expect(vi.mocked(generateObject)).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'openai/gpt-5.1' }),
      );
      expect(vi.mocked(generateObject).mock.calls[0]?.[0]).not.toHaveProperty('providerOptions');
    });

    it('rejects narrate requests without a configured API key', async () => {
      delete process.env.AI_GATEWAY_API_KEY;

      const response = await handleAiGatewayRequest(
        narrateRequest({ prompt: 'Narrate.', paths: ['a.ts'] }),
      );

      expect(response?.status).toBe(503);
      await expect(response?.json()).resolves.toHaveProperty('error');
      expect(vi.mocked(generateObject)).not.toHaveBeenCalled();
    });

    it('rejects invalid narrate payloads', async () => {
      for (const body of [
        {},
        { prompt: '   ' },
        { prompt: 42 },
        { prompt: 'Narrate.' },
        { prompt: 'Narrate.', paths: [] },
        { prompt: 'Narrate.', paths: 'src/app.ts' },
        { prompt: 'Narrate.', paths: ['a.ts', 7] },
      ]) {
        const response = await handleAiGatewayRequest(narrateRequest(body));

        expect(response?.status).toBe(400);
      }
      expect(vi.mocked(generateObject)).not.toHaveBeenCalled();
    });

    it('rejects narrate prompts over the size limit with a clear refusal', async () => {
      const response = await handleAiGatewayRequest(
        narrateRequest({ prompt: 'x'.repeat(NARRATE_PROMPT_MAX_BYTES + 1), paths: ['a.ts'] }),
      );

      expect(response?.status).toBe(413);
      await expect(response?.json()).resolves.toEqual({
        error: expect.stringContaining('Changeset too large to narrate'),
      });
      expect(vi.mocked(generateObject)).not.toHaveBeenCalled();
    });

    it('surfaces narration generation failures as structured errors', async () => {
      vi.mocked(generateObject).mockRejectedValueOnce(new Error('overloaded'));

      const response = await handleAiGatewayRequest(
        narrateRequest({ prompt: 'Narrate.', paths: ['a.ts'] }),
      );

      expect(response?.status).toBe(502);
      await expect(response?.json()).resolves.toEqual({
        error: 'Failed to generate narration',
      });
    });
  });

  it('answers unknown gateway paths and methods with 404', async () => {
    const unknownPath = await handleAiGatewayRequest(gatewayRequest('/ai-gateway/other'));
    expect(unknownPath?.status).toBe(404);

    const wrongMethod = await handleAiGatewayRequest(gatewayRequest('/ai-gateway/explain'));
    expect(wrongMethod?.status).toBe(404);
  });

  it('leaves non-gateway paths to the caller', async () => {
    expect(isAiGatewayPath('/ai-gateway/status')).toBe(true);
    expect(isAiGatewayPath('/index.html')).toBe(false);

    const response = await handleAiGatewayRequest(gatewayRequest('/api/diff'));
    expect(response).toBeNull();
  });
});
