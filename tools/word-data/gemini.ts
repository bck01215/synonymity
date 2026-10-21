/**
 * Minimal Gemini REST client for the word-data generator.
 *
 * Standalone on purpose: no @google/genai dependency, works under
 * `node --experimental-strip-types`. Mirrors the runtime client in
 * src/server/core/gemini.ts (same model, same endpoints).
 */

export type JsonSchema = Record<string, unknown>;

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
export const DEFAULT_CHAT_MODEL = process.env.GEMINI_CHAT_MODEL || 'gemini-3.6-flash';
export const DEFAULT_EMBEDDING_MODEL = process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-001';
const EMBED_BATCH_LIMIT = 100;

export function requireApiKey(): string {
  const key = process.env.GOOGLE_API_KEY || process.env.GENAI_API_KEY || '';
  if (!key) {
    throw new Error(
      'Missing GOOGLE_API_KEY (or GENAI_API_KEY). Export it to run this step, e.g.: ' +
        'export GOOGLE_API_KEY=***'
    );
  }
  return key;
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

type RetryableError = { status?: number };

/** Retry with exponential backoff + jitter on 429/5xx and network errors. */
export async function withRetries<T>(
  label: string,
  maxAttempts: number,
  attempt: (n: number) => Promise<T>
): Promise<T> {
  for (let n = 1; ; n++) {
    try {
      return await attempt(n);
    } catch (error) {
      const status = (error as RetryableError)?.status;
      const retryable =
        n < maxAttempts &&
        (status === 429 || status === 500 || status === 503 || status === undefined);
      if (!retryable) throw error;
      const delay = Math.round(2000 * 2 ** (n - 1) * (1 + Math.random()));
      console.warn(`[gemini] ${label} failed (attempt ${n}/${maxAttempts}); retrying in ${delay}ms`);
      await sleep(delay);
    }
  }
}

/**
 * Call generateContent and return the first non-thought text part.
 * `responseJsonSchema` enables JSON-mode structured output.
 */
export async function generateContent(params: {
  apiKey: string;
  system: string;
  user: string;
  responseJsonSchema?: JsonSchema;
  model?: string;
  maxOutputTokens?: number;
}): Promise<string> {
  const model = params.model ?? DEFAULT_CHAT_MODEL;
  return await withRetries(`generateContent (${model})`, 8, async () => {
    const response = await fetch(`${API_BASE}/models/${model}:generateContent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': params.apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: params.system }] },
        contents: [{ role: 'user', parts: [{ text: params.user }] }],
        generationConfig: {
          maxOutputTokens: params.maxOutputTokens ?? 512,
          thinkingConfig: { thinkingLevel: 'low' },
          ...(params.responseJsonSchema
            ? {
                responseMimeType: 'application/json',
                responseJsonSchema: params.responseJsonSchema,
              }
            : {}),
        },
      }),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300).replaceAll(params.apiKey, '[redacted]');
      const error = new Error(
        `Gemini API returned HTTP ${response.status}${detail ? ` (${detail})` : ''}`
      );
      (error as RetryableError).status = response.status;
      throw error;
    }
    const data = (await response.json()) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string; thought?: boolean }> };
      }>;
    };
    return (
      data.candidates?.[0]?.content?.parts
        ?.filter((part) => part.thought !== true && typeof part.text === 'string')
        .map((part) => part.text)
        .join('')
        .trim() ?? ''
    );
  });
}

/**
 * Embed up to `EMBED_BATCH_LIMIT` texts in one batchEmbedContents call and
 * return the vectors in input order.
 */
export async function embedBatch(params: {
  apiKey: string;
  texts: string[];
  model?: string;
}): Promise<number[][]> {
  if (params.texts.length === 0) return [];
  if (params.texts.length > EMBED_BATCH_LIMIT) {
    throw new Error(`embedBatch exceeds the API limit of ${EMBED_BATCH_LIMIT}`);
  }
  const model = params.model ?? DEFAULT_EMBEDDING_MODEL;
  return await withRetries(`batchEmbedContents (${model})`, 8, async () => {
    const modelPath = model.startsWith('models/') ? model : `models/${model}`;
    const response = await fetch(`${API_BASE}/models/${model}:batchEmbedContents`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': params.apiKey,
      },
      body: JSON.stringify({
        requests: params.texts.map((text) => ({
          model: modelPath,
          content: { parts: [{ text }] },
        })),
      }),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300).replaceAll(params.apiKey, '[redacted]');
      const error = new Error(
        `Gemini embedding API returned HTTP ${response.status}${detail ? ` (${detail})` : ''}`
      );
      (error as RetryableError).status = response.status;
      throw error;
    }
    const data = (await response.json()) as {
      embeddings?: Array<{ values?: number[] }>;
    };
    const vectors = data.embeddings?.map((e) => e.values);
    if (!vectors || vectors.length !== params.texts.length) {
      throw new Error(
        `Unexpected embedding response: expected ${params.texts.length} vectors`
      );
    }
    for (const values of vectors) {
      if (!values || values.length === 0) throw new Error('Empty embedding vector in response');
    }
    return vectors as number[][];
  });
}
