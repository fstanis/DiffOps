import { generateText } from 'ai';

import {
  DEFAULT_EXPLAIN_MODEL,
  EXPLAIN_PROMPT_MAX_BYTES,
  measureExplainPromptBytes,
} from '../utils/explainPrompt.js';

export function isExplainConfigured(): boolean {
  return Boolean(process.env.AI_GATEWAY_API_KEY?.trim());
}

/** Resolves the explain model from DIFFOPS_EXPLAIN_MODEL, defaulting to Sonnet. */
export function resolveExplainModel(): string {
  return process.env.DIFFOPS_EXPLAIN_MODEL?.trim() || DEFAULT_EXPLAIN_MODEL;
}

export type ExplainPromptValidation =
  | { ok: true; prompt: string }
  | { ok: false; status: 400 | 413; error: string };

export function validateExplainPrompt(value: unknown): ExplainPromptValidation {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return { ok: false, status: 400, error: 'Invalid request payload: expected a prompt string' };
  }
  if (measureExplainPromptBytes(value) > EXPLAIN_PROMPT_MAX_BYTES) {
    return {
      ok: false,
      status: 413,
      error: `Explain context exceeds the ${Math.round(EXPLAIN_PROMPT_MAX_BYTES / 1024)} KB limit`,
    };
  }
  return { ok: true, prompt: value };
}

// Anthropic models must be served through the Google Vertex AI deployment;
// `only` fails the request outright rather than falling back to another route.
export const VERTEX_ANTHROPIC_ONLY = { gateway: { only: ['vertexAnthropic'] } };

export async function generateExplanation(prompt: string, model: string): Promise<string> {
  const { text } = await generateText({
    model,
    prompt,
    ...(model.startsWith('anthropic/') ? { providerOptions: VERTEX_ANTHROPIC_ONLY } : {}),
  });
  return text;
}
