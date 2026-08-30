import { generateObject, jsonSchema } from 'ai';

import type { Narration } from '../types/diff.js';
import {
  DEFAULT_NARRATE_MODEL,
  NARRATE_PROMPT_MAX_BYTES,
  measureNarratePromptBytes,
} from '../utils/narratePrompt.js';
import { VERTEX_ANTHROPIC_ONLY } from './explain.js';

/** Resolves the narration model from DIFFOPS_NARRATE_MODEL, defaulting to Opus. */
export function resolveNarrateModel(): string {
  return process.env.DIFFOPS_NARRATE_MODEL?.trim() || DEFAULT_NARRATE_MODEL;
}

export type NarrateRequestValidation =
  | { ok: true; prompt: string; paths: string[] }
  | { ok: false; status: 400 | 413; error: string };

export function validateNarrateRequest(value: unknown): NarrateRequestValidation {
  const body = value as { prompt?: unknown; paths?: unknown } | null;
  if (typeof body?.prompt !== 'string' || body.prompt.trim().length === 0) {
    return { ok: false, status: 400, error: 'Invalid request payload: expected a prompt string' };
  }
  const isValidPaths =
    Array.isArray(body.paths) &&
    body.paths.length > 0 &&
    body.paths.every((path) => typeof path === 'string' && path.length > 0);
  if (!isValidPaths) {
    return {
      ok: false,
      status: 400,
      error: 'Invalid request payload: expected a non-empty paths array',
    };
  }
  if (measureNarratePromptBytes(body.prompt) > NARRATE_PROMPT_MAX_BYTES) {
    return {
      ok: false,
      status: 413,
      error: `Changeset too large to narrate: prompt exceeds the ${Math.round(NARRATE_PROMPT_MAX_BYTES / 1024)} KB limit`,
    };
  }
  return { ok: true, prompt: body.prompt, paths: body.paths as string[] };
}

const NARRATION_SCHEMA = jsonSchema<Narration>({
  type: 'object',
  required: ['intro', 'cards', 'epilogue'],
  additionalProperties: false,
  properties: {
    intro: { type: 'string' },
    epilogue: { type: 'string' },
    cards: {
      type: 'array',
      items: {
        type: 'object',
        required: ['path', 'narrative'],
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          narrative: { type: 'string' },
        },
      },
    },
  },
});

/**
 * Completes the model's card list into a permutation of paths: unknown and
 * duplicate paths are dropped, missing files are appended in prompt order.
 */
function normalizeNarrationOrder(narration: Narration, paths: string[]): Narration {
  const knownPaths = new Set(paths);
  const seen = new Set<string>();
  const cards: Narration['cards'] = [];

  for (const card of narration.cards) {
    if (!knownPaths.has(card.path) || seen.has(card.path)) {
      continue;
    }
    seen.add(card.path);
    cards.push(card);
  }

  for (const path of paths) {
    if (!seen.has(path)) {
      cards.push({ path, narrative: '' });
    }
  }

  return { intro: narration.intro, cards, epilogue: narration.epilogue };
}

export async function generateNarration(
  prompt: string,
  paths: string[],
  model: string,
): Promise<Narration> {
  const { object } = await generateObject({
    model,
    schema: NARRATION_SCHEMA,
    prompt,
    ...(model.startsWith('anthropic/') ? { providerOptions: VERTEX_ANTHROPIC_ONLY } : {}),
  });
  return normalizeNarrationOrder(object, paths);
}
