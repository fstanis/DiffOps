// The /ai-gateway surface — the only dynamic routes the diffops server exposes.
// Pure Request/Response handlers so serve.ts can dispatch here and tests can
// drive them without a server.
import type { ExplainStatusResponse } from '../types/diff.js';

import {
  generateExplanation,
  isExplainConfigured,
  resolveExplainModel,
  validateExplainPrompt,
} from './explain.js';

const STATUS_PATH = '/ai-gateway/status';
const EXPLAIN_PATH = '/ai-gateway/explain';

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });

const statusResponse = (): Response =>
  jsonResponse({
    enabled: isExplainConfigured(),
    model: resolveExplainModel(),
  } satisfies ExplainStatusResponse);

const explainResponse = async (request: Request): Promise<Response> => {
  if (!isExplainConfigured()) {
    return jsonResponse(
      { error: 'Explain is not configured: set the AI_GATEWAY_API_KEY environment variable' },
      503,
    );
  }

  try {
    const body: unknown = await request.json().catch(() => null);
    const validation = validateExplainPrompt((body as { prompt?: unknown } | null)?.prompt);
    if (!validation.ok) {
      return jsonResponse({ error: validation.error }, validation.status);
    }

    const explanation = await generateExplanation(validation.prompt, resolveExplainModel());
    return jsonResponse({ explanation });
  } catch (error) {
    console.error('Error generating explanation:', error);
    return jsonResponse({ error: 'Failed to generate explanation' }, 502);
  }
};

/** Whether a request pathname belongs to the gateway surface. */
export const isAiGatewayPath = (pathname: string): boolean => pathname.startsWith('/ai-gateway/');

/**
 * Answers gateway requests; a null response means the pathname is not a
 * gateway route and the caller should keep resolving it.
 */
export async function handleAiGatewayRequest(request: Request): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (!isAiGatewayPath(pathname)) {
    return null;
  }
  if (pathname === STATUS_PATH && request.method === 'GET') {
    return statusResponse();
  }
  if (pathname === EXPLAIN_PATH && request.method === 'POST') {
    return explainResponse(request);
  }
  return new Response('Not found', { status: 404 });
}
