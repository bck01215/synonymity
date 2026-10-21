import { gunzipSync, gzipSync } from 'node:zlib';
import { z } from 'zod';

/**
 * Pure encode/decode for the static word-data files (`word-data/v1/*`).
 *
 * This module has no I/O, devvit, or network dependencies so it can be
 * shared by the runtime server (decode) and the offline word-data generator
 * (encode). Keep the two directions in sync: any format change must update
 * both `decodeStatic*` and `encodeStatic*` and their tests.
 */

const rankedWordSchema = z
  .object({
    word: z.string().min(1),
    similarity: z.number().finite(),
    isHint: z.boolean(),
  })
  .strict();

export const DICTIONARY_HEADER = 'id,word,isHint';
const MAGIC = 'HCW2';
const HEADER_BYTES = 12;
const EXACT_RECORD_BYTES = 10;
const QUANTIZED_RECORD_BYTES = 4;
const SIMILARITY_SCALE = 10_000;

/** Default number of top-ranked neighbors stored at full float64 precision. */
export const DEFAULT_EXACT_COUNT = 2500;

export type StaticWordConfig = {
  closest_word: string;
  closest_similarity: number;
  furthest_word: string;
  furthest_similarity: number;
  similar_words: Array<{ word: string; similarity: number; is_hint: boolean }>;
};

export type StaticDictionary = {
  words: readonly string[];
  hints: readonly boolean[];
};

export const normalizeWord = (word: string): string => word.trim().toLowerCase();

function parseCsvRow(row: string): string[] {
  const fields: string[] = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < row.length; index++) {
    const char = row[index]!;
    if (char === '"') {
      if (quoted && row[index + 1] === '"') {
        field += '"';
        index++;
      } else {
        quoted = !quoted;
      }
    } else if (char === ',' && !quoted) {
      fields.push(field);
      field = '';
    } else {
      field += char;
    }
  }

  if (quoted) throw new Error('Unterminated quoted CSV field');
  fields.push(field);
  return fields;
}

export function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function parseBoolean(value: string): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`Invalid boolean value: ${value}`);
}

function decompress(bytes: Uint8Array): Buffer {
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return Buffer.from(bytes);
  return gunzipSync(bytes);
}

/** Decompress when the payload is gzipped; pass through otherwise. */
export function decompressStatic(bytes: Uint8Array): Buffer {
  return decompress(bytes);
}

// ---------------------------------------------------------
// Dictionary
// ---------------------------------------------------------

export function decodeStaticDictionary(bytes: Uint8Array): StaticDictionary {
  const lines = decompress(bytes).toString('utf8').split(/\r?\n/).filter(Boolean);
  if (lines[0] !== DICTIONARY_HEADER) throw new Error('Unexpected static dictionary header');

  const words: string[] = [];
  const hints: boolean[] = [];
  for (let index = 1; index < lines.length; index++) {
    const fields = parseCsvRow(lines[index]!);
    if (fields.length !== 3 || Number(fields[0]) !== index - 1) {
      throw new Error(`Invalid static dictionary row ${index}`);
    }
    const word = normalizeWord(fields[1]!);
    if (!word) throw new Error(`Empty static dictionary word at row ${index}`);
    words.push(word);
    hints.push(parseBoolean(fields[2]!));
  }
  if (words.length === 0 || new Set(words).size !== words.length) {
    throw new Error('Static dictionary is empty or contains duplicates');
  }
  if (words.length > 65_535) throw new Error('Static dictionary exceeds uint16 IDs');
  return { words, hints };
}

/** Serialize a dictionary in the `_dictionary.csv.gz` format. */
export function encodeStaticDictionary(dictionary: StaticDictionary): Buffer {
  const lines = [
    DICTIONARY_HEADER,
    ...dictionary.words.map((word, index) => {
      const hint = dictionary.hints[index];
      return `${index},${csvField(word)},${hint === undefined ? 'false' : hint}`;
    }),
  ];
  return gzipSync(`${lines.join('\n')}\n`, { level: 9 });
}

// ---------------------------------------------------------
// Per-target ranking
// ---------------------------------------------------------

export function decodeStaticWordConfig(
  bytes: Uint8Array,
  expectedSecret: string,
  dictionary: StaticDictionary
): StaticWordConfig {
  const data = decompress(bytes);
  if (data.length < HEADER_BYTES || data.toString('ascii', 0, 4) !== MAGIC) {
    throw new Error('Unsupported static word-data format');
  }

  const neighborCount = data.readUInt32LE(4);
  const secretId = data.readUInt16LE(8);
  const exactCount = data.readUInt16LE(10);
  const expected = normalizeWord(expectedSecret);
  if (neighborCount !== dictionary.words.length - 1) {
    throw new Error(
      `${expected} has ${neighborCount} neighbors; expected ${dictionary.words.length - 1}`
    );
  }
  if (exactCount > neighborCount) throw new Error(`Invalid exact-row count for ${expected}`);
  if (dictionary.words[secretId] !== expected) {
    throw new Error(`Invalid secret ID for static target "${expected}"`);
  }

  const expectedBytes =
    HEADER_BYTES +
    exactCount * EXACT_RECORD_BYTES +
    (neighborCount - exactCount) * QUANTIZED_RECORD_BYTES;
  if (data.length !== expectedBytes) {
    throw new Error(`Invalid static target byte length for "${expected}"`);
  }

  const seenIds = new Set<number>([secretId]);
  const neighbors: Array<z.infer<typeof rankedWordSchema>> = [];
  let offset = HEADER_BYTES;
  for (let index = 0; index < neighborCount; index++) {
    const wordId = data.readUInt16LE(offset);
    if (wordId >= dictionary.words.length || seenIds.has(wordId)) {
      throw new Error(`Invalid or duplicate word ID at rank ${index + 1} for "${expected}"`);
    }
    seenIds.add(wordId);
    const similarity =
      index < exactCount
        ? data.readDoubleLE(offset + 2)
        : data.readInt16LE(offset + 2) / SIMILARITY_SCALE;
    neighbors.push(
      rankedWordSchema.parse({
        word: dictionary.words[wordId],
        similarity,
        isHint: dictionary.hints[wordId],
      })
    );
    offset += index < exactCount ? EXACT_RECORD_BYTES : QUANTIZED_RECORD_BYTES;
  }

  const closest = neighbors[0];
  const furthest = neighbors.at(-1);
  if (!closest || !furthest || seenIds.size !== dictionary.words.length) {
    throw new Error(`Incomplete static rankings for "${expected}"`);
  }
  return {
    closest_word: closest.word,
    closest_similarity: closest.similarity,
    furthest_word: furthest.word,
    furthest_similarity: furthest.similarity,
    similar_words: neighbors.map((neighbor) => ({
      word: neighbor.word,
      similarity: neighbor.similarity,
      is_hint: neighbor.isHint,
    })),
  };
}

export type WordConfigNeighbor = {
  word: string;
  similarity: number;
};

/**
 * Render the per-letter CSV served to the client for one challenge word.
 *
 * Pure string processing over a decoded word config, so it lives with the
 * codec (and can be exercised by the offline word-data tooling) instead of
 * api.ts. The secret word itself is injected with similarity 1 and rank 0 —
 * the client treats similarity === 1 as the winning guess, so every other
 * row must render below 1.0000 at four decimal places.
 */
export function renderLetterCsv(
  challengeSecretWord: string,
  letter: string,
  wordConfig: StaticWordConfig
): string {
  const header = 'word,similarity,rank';
  const lower = letter.toLowerCase();
  const records: { word: string; similarity: number; rank: number }[] = [];

  for (let index = 0; index < wordConfig.similar_words.length; index++) {
    const entry = wordConfig.similar_words[index]!;
    if (entry.word && entry.word[0]?.toLowerCase() === lower) {
      records.push({ word: entry.word, similarity: entry.similarity, rank: index + 1 });
    }
  }

  if (challengeSecretWord[0]?.toLowerCase() === lower) {
    records.push({ word: challengeSecretWord, similarity: 1, rank: 0 });
  }

  const sorted = records.sort((left, right) =>
    left.word.localeCompare(right.word, undefined, { sensitivity: 'base' })
  );
  return [
    header,
    ...sorted.map((record) => `${record.word},${record.similarity.toFixed(4)},${record.rank}`),
  ].join('\n');
}

/**
 * Serialize a per-target ranking in the `<word>.bin.gz` (HCW2) format.
 *
 * The ranking must cover every dictionary word except the target, ordered
 * closest to furthest. The first `exactCount` neighbors are stored at full
 * float64 precision; the rest are quantized to int16 / 10_000.
 *
 * Similarity must stay in [-1, 1]. The generator additionally clamps the
 * upper bound below 1 (see tools/word-data) because the client treats a
 * similarity of exactly 1 as the winning guess.
 */
export function encodeStaticWordConfig(params: {
  word: string;
  dictionary: StaticDictionary;
  neighbors: readonly WordConfigNeighbor[];
  exactCount?: number;
}): Buffer {
  const { word: rawWord, dictionary, neighbors } = params;
  const word = normalizeWord(rawWord);
  const exactCount = params.exactCount ?? DEFAULT_EXACT_COUNT;

  const wordIds = new Map(dictionary.words.map((w, id) => [w, id]));
  const secretId = wordIds.get(word);
  if (secretId == null) throw new Error(`Target is missing from dictionary: ${word}`);

  const neighborCount = dictionary.words.length - 1;
  if (neighbors.length !== neighborCount) {
    throw new Error(
      `${word} returned ${neighbors.length} neighbors; expected ${neighborCount}`
    );
  }
  if (exactCount < 0 || exactCount > neighborCount) {
    throw new Error(`Invalid exact-row count ${exactCount} for ${word}`);
  }

  const seen = new Set<number>([secretId]);
  for (const neighbor of neighbors) {
    const id = wordIds.get(normalizeWord(neighbor.word));
    if (id == null) throw new Error(`Ranked word is missing from dictionary: ${neighbor.word}`);
    if (seen.has(id)) throw new Error(`Duplicate ranked word for "${word}": ${neighbor.word}`);
    seen.add(id);
    if (!Number.isFinite(neighbor.similarity) || neighbor.similarity < -1 || neighbor.similarity > 1) {
      throw new Error(
        `Similarity for "${neighbor.word}" against "${word}" out of range: ${neighbor.similarity}`
      );
    }
  }

  const bytes = Buffer.allocUnsafe(
    HEADER_BYTES + exactCount * EXACT_RECORD_BYTES + (neighborCount - exactCount) * QUANTIZED_RECORD_BYTES
  );
  bytes.write(MAGIC, 0, 'ascii');
  bytes.writeUInt32LE(neighborCount, 4);
  bytes.writeUInt16LE(secretId, 8);
  bytes.writeUInt16LE(exactCount, 10);

  let offset = HEADER_BYTES;
  for (let index = 0; index < neighborCount; index++) {
    const neighbor = neighbors[index]!;
    const wordId = wordIds.get(normalizeWord(neighbor.word))!;
    bytes.writeUInt16LE(wordId, offset);
    if (index < exactCount) {
      bytes.writeDoubleLE(neighbor.similarity, offset + 2);
      offset += EXACT_RECORD_BYTES;
    } else {
      const quantized = Math.max(
        -SIMILARITY_SCALE,
        Math.min(SIMILARITY_SCALE, Math.round(neighbor.similarity * SIMILARITY_SCALE))
      );
      bytes.writeInt16LE(quantized, offset + 2);
      offset += QUANTIZED_RECORD_BYTES;
    }
  }
  return gzipSync(bytes, { level: 9 });
}
