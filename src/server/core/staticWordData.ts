import { cache } from '@devvit/web/server';
import { WORD_DATA_RELEASE } from '../../shared/wordDataVersion';
import {
  decodeStaticDictionary,
  decodeStaticWordConfig,
  normalizeWord,
} from './wordDataFormat';
import type { StaticDictionary, StaticWordConfig } from './wordDataFormat';

export const STATIC_WORD_DATA_BASE_URL =
  'https://raw.githubusercontent.com/bck01215/synonymity/main/word-data/v1';

// Format codec lives in wordDataFormat (shared with the offline generator).
export {
  decodeStaticDictionary,
  decodeStaticWordConfig,
  encodeStaticDictionary,
  encodeStaticWordConfig,
} from './wordDataFormat';
export type { StaticDictionary, StaticWordConfig } from './wordDataFormat';

const STATIC_FETCH_TIMEOUT_MS = 15_000;
const STATIC_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;

const staticWordDataUrl = (path: string): string =>
  `${STATIC_WORD_DATA_BASE_URL}/${path}?release=${encodeURIComponent(WORD_DATA_RELEASE)}`;

const wordFileName = (word: string): string =>
  `${encodeURIComponent(word).replaceAll("'", '%27')}.bin.gz`;

async function fetchStaticBytesFromOrigin(
  path: string,
  url: string,
  cacheKey: string,
  reason: 'cache-fill' | 'cache-bypass'
): Promise<Buffer | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), STATIC_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/octet-stream' },
      signal: controller.signal,
    });
    if (response.status === 404) {
      console.error('[word-data] GitHub Raw file not found', { path, url, cacheKey, reason });
      return null;
    }
    if (!response.ok) {
      throw new Error(`Static word data returned HTTP ${response.status} for ${path}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    return bytes;
  } catch (error) {
    console.error('[word-data] GitHub Raw fetch failed', { path, url, cacheKey, reason, error });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchStaticBytes(path: string): Promise<Uint8Array | null> {
  const url = staticWordDataUrl(path);
  const cacheKey = `static-word-data:${WORD_DATA_RELEASE}:${path}`;
  let cacheFillAttempted = false;
  try {
    const cached = await cache(
      async (): Promise<{ found: true; base64: string }> => {
        cacheFillAttempted = true;
        const bytes = await fetchStaticBytesFromOrigin(path, url, cacheKey, 'cache-fill');
        if (!bytes) {
          // Cache helper stores both returned values and errors. Throwing avoids a 30-day
          // successful negative value; the caller bypasses cached errors on later requests.
          throw new Error(`Static word data returned HTTP 404 for ${path}`);
        }
        return { found: true, base64: bytes.toString('base64') };
      },
      {
        key: cacheKey,
        ttl: STATIC_CACHE_TTL_SECONDS,
      }
    );
    return Buffer.from(cached.base64, 'base64');
  } catch (error) {
    if (cacheFillAttempted && error instanceof Error && error.message.includes('HTTP 404')) {
      return null;
    }
    console.warn('[word-data] cache-helper failed; bypassing cache', {
      path,
      cacheKey,
      error,
    });
    return await fetchStaticBytesFromOrigin(path, url, cacheKey, 'cache-bypass');
  }
}

async function staticFileExists(path: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), STATIC_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(staticWordDataUrl(path), {
      method: 'HEAD',
      signal: controller.signal,
    });
    if (response.status === 404) return false;
    if (!response.ok) {
      throw new Error(`Static word data returned HTTP ${response.status} for ${path}`);
    }
    return true;
  } finally {
    clearTimeout(timeout);
  }
}

let dictionaryMemory: StaticDictionary | null = null;
let dictionaryPending: Promise<StaticDictionary | null> | null = null;

async function getStaticDictionary(): Promise<StaticDictionary | null> {
  if (dictionaryMemory) return dictionaryMemory;
  if (dictionaryPending) return dictionaryPending;
  dictionaryPending = (async () => {
    const bytes = await fetchStaticBytes('_dictionary.csv.gz');
    if (!bytes) {
      console.error('[word-data] dictionary file is unavailable');
      return null;
    }
    try {
      dictionaryMemory = decodeStaticDictionary(bytes);
      return dictionaryMemory;
    } catch (error) {
      console.error('[word-data] dictionary decode failed', {
        compressedBytes: bytes.byteLength,
        error,
      });
      throw error;
    }
  })();
  try {
    return await dictionaryPending;
  } finally {
    dictionaryPending = null;
  }
}

export async function getStaticWordConfig(word: string): Promise<StaticWordConfig | null> {
  const normalized = normalizeWord(word);
  const path = wordFileName(normalized);
  const [dictionary, bytes] = await Promise.all([getStaticDictionary(), fetchStaticBytes(path)]);
  if (!bytes) {
    console.error('[word-data] target file is unavailable', {
      word: normalized,
      path,
      release: WORD_DATA_RELEASE,
    });
    return null;
  }
  if (!dictionary) {
    console.error('[word-data] cannot decode target without dictionary', {
      word: normalized,
      path,
      targetBytes: bytes.byteLength,
    });
    throw new Error('Static word dictionary is unavailable');
  }
  try {
    return decodeStaticWordConfig(bytes, normalized, dictionary);
  } catch (error) {
    console.error('[word-data] target decode failed', {
      word: normalized,
      path,
      targetBytes: bytes.byteLength,
      dictionaryWords: dictionary.words.length,
      error,
    });
    throw error;
  }
}

export async function hasStaticWordConfig(word: string): Promise<boolean> {
  return await staticFileExists(wordFileName(normalizeWord(word)));
}
