import { generateObject, jsonSchema } from 'ai';

import type { FileExplanation } from '../types/diff.js';
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

export type ExplainRequestValidation =
  | { ok: true; prompt: string; candidateFiles: string[] }
  | { ok: false; status: 400 | 413; error: string };

export function validateExplainRequest(value: unknown): ExplainRequestValidation {
  const body = value as { prompt?: unknown; candidateFiles?: unknown } | null;
  if (typeof body?.prompt !== 'string' || body.prompt.trim().length === 0) {
    return { ok: false, status: 400, error: 'Invalid request payload: expected a prompt string' };
  }
  if (
    body.candidateFiles !== undefined &&
    (!Array.isArray(body.candidateFiles) ||
      !body.candidateFiles.every((path) => typeof path === 'string' && path.length > 0))
  ) {
    return {
      ok: false,
      status: 400,
      error: 'Invalid request payload: expected candidateFiles to be an array of file paths',
    };
  }
  if (measureExplainPromptBytes(body.prompt) > EXPLAIN_PROMPT_MAX_BYTES) {
    return {
      ok: false,
      status: 413,
      error: `Explain context exceeds the ${Math.round(EXPLAIN_PROMPT_MAX_BYTES / 1024)} KB limit`,
    };
  }
  return {
    ok: true,
    prompt: body.prompt,
    candidateFiles: (body.candidateFiles as string[] | undefined) ?? [],
  };
}

// Anthropic models must be served through the Google Vertex AI deployment;
// `only` fails the request outright rather than falling back to another route.
export const VERTEX_ANTHROPIC_ONLY = { gateway: { only: ['vertexAnthropic'] } };

// First round: the model may request additional files from the offered candidates.
const FIRST_ROUND_EXPLANATION_SCHEMA = jsonSchema<FileExplanation>({
  type: 'object',
  required: ['fileSummary', 'symbols', 'additionalFilesNeeded'],
  additionalProperties: false,
  properties: {
    fileSummary: { type: 'string' },
    symbols: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'type', 'summary'],
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          type: { type: 'string', enum: ['function', 'method', 'class', 'constant', 'other'] },
          summary: { type: 'string' },
          contract: {
            type: 'object',
            required: ['input', 'output'],
            additionalProperties: false,
            properties: {
              input: { type: 'string' },
              output: { type: 'string' },
            },
          },
        },
      },
    },
    additionalFilesNeeded: { type: 'array', items: { type: 'string' } },
  },
});

// Final round: no further file requests exist, so the property is omitted.
const FINAL_ROUND_EXPLANATION_SCHEMA = jsonSchema<Omit<FileExplanation, 'additionalFilesNeeded'>>({
  type: 'object',
  required: ['fileSummary', 'symbols'],
  additionalProperties: false,
  properties: {
    fileSummary: { type: 'string' },
    symbols: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'type', 'summary'],
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          type: { type: 'string', enum: ['function', 'method', 'class', 'constant', 'other'] },
          summary: { type: 'string' },
          contract: {
            type: 'object',
            required: ['input', 'output'],
            additionalProperties: false,
            properties: {
              input: { type: 'string' },
              output: { type: 'string' },
            },
          },
        },
      },
    },
  },
});

/**
 * Drops requested files the model was never offered, keeping model order and
 * deduplicating — hallucinated paths cannot reach the client.
 */
function clampRequestedFiles(requested: string[], candidates: string[]): string[] {
  const offered = new Set(candidates);
  const seen = new Set<string>();
  const clamped: string[] = [];
  for (const path of requested) {
    if (offered.has(path) && !seen.has(path)) {
      seen.add(path);
      clamped.push(path);
    }
  }
  return clamped;
}

export async function generateFileExplanation(
  prompt: string,
  candidateFiles: string[],
  model: string,
): Promise<FileExplanation> {
  const providerOptions = model.startsWith('anthropic/')
    ? { providerOptions: VERTEX_ANTHROPIC_ONLY }
    : {};

  if (candidateFiles.length === 0) {
    const { object } = await generateObject({
      model,
      schema: FINAL_ROUND_EXPLANATION_SCHEMA,
      prompt,
      ...providerOptions,
    });
    return { ...object, additionalFilesNeeded: [] };
  }

  const { object } = await generateObject({
    model,
    schema: FIRST_ROUND_EXPLANATION_SCHEMA,
    prompt,
    ...providerOptions,
  });
  return {
    ...object,
    additionalFilesNeeded: clampRequestedFiles(object.additionalFilesNeeded, candidateFiles),
  };
}
