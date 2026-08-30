import { describe, it, expect, vi, beforeEach, afterEach } from 'bun:test';

import { handleAiGatewayRequest, isAiGatewayPath } from './ai-gateway.js';
import { EXPLAIN_PROMPT_MAX_BYTES } from '../utils/explainPrompt.js';

// Mock the AI SDK so gateway tests never reach the network
vi.mock('ai', () => ({
  generateText: vi.fn(),
}));
const { generateText } = await import('ai');

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

  beforeEach(() => {
    vi.mocked(generateText).mockReset();
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
  });

  it('reports disabled with the default model when no API key is set', async () => {
    delete process.env.AI_GATEWAY_API_KEY;

    const response = await handleAiGatewayRequest(gatewayRequest('/ai-gateway/status'));

    expect(response).not.toBeNull();
    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual({
      enabled: false,
      model: 'anthropic/claude-sonnet-5',
    });
  });

  it('reports enabled with the DIFFOPS_EXPLAIN_MODEL override', async () => {
    process.env.DIFFOPS_EXPLAIN_MODEL = 'openai/gpt-5.1';

    const response = await handleAiGatewayRequest(gatewayRequest('/ai-gateway/status'));

    expect(response).not.toBeNull();
    await expect(response?.json()).resolves.toEqual({ enabled: true, model: 'openai/gpt-5.1' });
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
