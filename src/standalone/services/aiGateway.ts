// Only outbound AI surface: calls Vercel's AI Gateway directly from the browser, since the gateway answers cross-origin requests and needs no server in this path.
import {
  createGateway,
  generateObject,
  jsonSchema,
  type JSONSchema7,
  type LanguageModel,
} from 'ai';

import type { FileExplanation, Narration } from '../../types/diff';

// Anthropic models must route through the Vertex AI deployment; `only` fails outright rather than falling back to another route.
const VERTEX_ANTHROPIC_ONLY = { gateway: { only: ['vertexAnthropic'] } };

/** The model handle plus the provider routing the model id implies. */
const resolveModel = (
  model: string,
  apiKey: string,
): { model: LanguageModel; providerOptions?: typeof VERTEX_ANTHROPIC_ONLY } => ({
  // A bare model-id string would resolve via the SDK's global registry, which reads the API key from an environment the browser does not have.
  model: createGateway({ apiKey }).languageModel(model),
  ...(model.startsWith('anthropic/') ? { providerOptions: VERTEX_ANTHROPIC_ONLY } : {}),
});

const EXPLANATION_SYMBOLS_SCHEMA: JSONSchema7 = {
  type: 'array',
  items: {
    type: 'object',
    required: ['name', 'type', 'summary', 'isPublic'],
    additionalProperties: false,
    properties: {
      name: { type: 'string' },
      type: { type: 'string', enum: ['function', 'method', 'class', 'constant', 'other'] },
      summary: { type: 'string' },
      isPublic: { type: 'boolean' },
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
};

// First round: the model may request additional files from the offered candidates.
const FIRST_ROUND_EXPLANATION_SCHEMA = jsonSchema<FileExplanation>({
  type: 'object',
  required: ['fileSummary', 'symbols', 'additionalFilesNeeded'],
  additionalProperties: false,
  properties: {
    fileSummary: { type: 'string' },
    symbols: EXPLANATION_SYMBOLS_SCHEMA,
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
    symbols: EXPLANATION_SYMBOLS_SCHEMA,
  },
});

// A `jsonSchema()` without a `validate` function carries no validator, so the
// SDK hands back whatever JSON the model produced — a required field the model
// left out arrives as undefined. Every answer is therefore checked here rather
// than trusted; an omitted `additionalFilesNeeded` used to reach the UI as
// "e is not iterable".
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

/** The half of an explanation the panel cannot render without; anything else is recoverable. */
function readExplanationCore(object: unknown): Omit<FileExplanation, 'additionalFilesNeeded'> {
  if (
    !isRecord(object) ||
    typeof object.fileSummary !== 'string' ||
    !Array.isArray(object.symbols)
  ) {
    throw new Error('The model returned an explanation this app could not read');
  }
  return {
    fileSummary: object.fileSummary,
    symbols: object.symbols.filter((symbol): symbol is FileExplanation['symbols'][number] =>
      isRecord(symbol),
    ),
  };
}

/**
 * Drops requested files the model was never offered, keeping model order and
 * deduplicating — hallucinated paths cannot reach the UI.
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

export interface FileExplanationRequest {
  prompt: string;
  /** Paths the model may request; empty selects the schema without file requests. */
  candidateFiles: string[];
  model: string;
  apiKey: string;
  signal?: AbortSignal;
}

export async function generateFileExplanation({
  prompt,
  candidateFiles,
  model,
  apiKey,
  signal,
}: FileExplanationRequest): Promise<FileExplanation> {
  const call = { ...resolveModel(model, apiKey), prompt, abortSignal: signal };

  if (candidateFiles.length === 0) {
    const { object } = await generateObject({ ...call, schema: FINAL_ROUND_EXPLANATION_SCHEMA });
    return { ...readExplanationCore(object), additionalFilesNeeded: [] };
  }

  const { object } = await generateObject({ ...call, schema: FIRST_ROUND_EXPLANATION_SCHEMA });
  return {
    ...readExplanationCore(object),
    // A model that answered without requesting anything is asking for nothing.
    additionalFilesNeeded: clampRequestedFiles(
      asStringArray(isRecord(object) ? object.additionalFilesNeeded : undefined),
      candidateFiles,
    ),
  };
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
function normalizeNarrationOrder(narration: unknown, paths: string[]): Narration {
  const answer = isRecord(narration) ? narration : {};
  const knownPaths = new Set(paths);
  const seen = new Set<string>();
  const cards: Narration['cards'] = [];

  // An unusable card list narrates nothing rather than failing the whole
  // review: every path below still gets its (empty) card, in prompt order.
  const modelCards = Array.isArray(answer.cards) ? answer.cards : [];
  for (const card of modelCards) {
    if (!isRecord(card) || typeof card.path !== 'string' || typeof card.narrative !== 'string') {
      continue;
    }
    if (!knownPaths.has(card.path) || seen.has(card.path)) {
      continue;
    }
    seen.add(card.path);
    cards.push({ path: card.path, narrative: card.narrative });
  }

  for (const path of paths) {
    if (!seen.has(path)) {
      cards.push({ path, narrative: '' });
    }
  }

  return {
    intro: typeof answer.intro === 'string' ? answer.intro : '',
    cards,
    epilogue: typeof answer.epilogue === 'string' ? answer.epilogue : '',
  };
}

export interface NarrationRequest {
  prompt: string;
  paths: string[];
  model: string;
  apiKey: string;
}

export async function generateNarration({
  prompt,
  paths,
  model,
  apiKey,
}: NarrationRequest): Promise<Narration> {
  const { object } = await generateObject({
    ...resolveModel(model, apiKey),
    schema: NARRATION_SCHEMA,
    prompt,
  });
  return normalizeNarrationOrder(object, paths);
}
