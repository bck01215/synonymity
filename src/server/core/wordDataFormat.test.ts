import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { test, expect } from 'vitest';
import {
  DEFAULT_EXACT_COUNT,
  decodeStaticDictionary,
  decodeStaticWordConfig,
  encodeStaticDictionary,
  encodeStaticWordConfig,
} from './wordDataFormat';

const DICT_WORDS = [
  'apple',
  'apex',
  'banana',
  'couch',
  'fork',
  'fortnight',
  'pitchfork',
  'river',
  'sofa',
  'zebra',
];
const DICT_HINTS = [false, true, false, true, false, false, true, true, true, false];

function makeDictionary() {
  return { words: DICT_WORDS, hints: DICT_HINTS } as const;
}

test('dictionary round-trips through encode/decode', () => {
  const bytes = encodeStaticDictionary(makeDictionary());
  const decoded = decodeStaticDictionary(bytes);
  expect([...decoded.words]).toEqual(DICT_WORDS);
  expect([...decoded.hints]).toEqual(DICT_HINTS);
});

test('word config round-trips preserving rank order', () => {
  const dictionary = makeDictionary();
  const neighbors = [
    { word: 'sofa', similarity: 0.9123456789 },
    { word: 'couch', similarity: 0.87 },
    { word: 'zebra', similarity: 0.5 },
    { word: 'river', similarity: 0.25 },
    { word: 'banana', similarity: 0.123456 },
    { word: 'apex', similarity: 0.05 },
    { word: 'apple', similarity: 0.01 },
    { word: 'fortnight', similarity: -0.02 },
    { word: 'pitchfork', similarity: 0.71 },
  ];
  // Neighbors must exclude the target ('fork') and cover everything else.
  const ordered = [
    'sofa',
    'couch',
    'pitchfork',
    'zebra',
    'river',
    'banana',
    'apex',
    'apple',
    'fortnight',
  ].map((word) => neighbors.find((n) => n.word === word)!);

  const bytes = encodeStaticWordConfig({
    word: 'fork',
    dictionary,
    neighbors: ordered,
    exactCount: 3,
  });

  const decoded = decodeStaticWordConfig(bytes, 'fork', dictionary);
  expect(decoded.closest_word).toBe('sofa');
  expect(decoded.furthest_word).toBe('fortnight');
  expect(decoded.similar_words.map((w) => w.word)).toEqual([
    'sofa',
    'couch',
    'pitchfork',
    'zebra',
    'river',
    'banana',
    'apex',
    'apple',
    'fortnight',
  ]);
  // Exact rows keep full precision; quantized rows are int16/10000.
  expect(decoded.similar_words[0]!.similarity).toBeCloseTo(0.9123456789, 12);
  expect(decoded.similar_words[2]!.similarity).toBeCloseTo(0.71, 12);
  expect(decoded.similar_words[3]!.similarity).toBe(0.5); // quantized
  expect(decoded.similar_words[7]!.similarity).toBe(0.01); // quantized
  // Hint flags come from the dictionary.
  expect(decoded.similar_words.map((w) => w.is_hint)).toEqual([true, true, true, false, true, false, true, false, false]);
});

test('quantization clamps to the int16 scale', () => {
  const dictionary = makeDictionary();
  const neighbors = DICT_WORDS.filter((w) => w !== 'fork').map((word, index) => ({
    word,
    similarity: 1 - index / 100,
  }));
  const bytes = encodeStaticWordConfig({ word: 'fork', dictionary, neighbors, exactCount: 0 });
  const decoded = decodeStaticWordConfig(bytes, 'fork', dictionary);
  expect(decoded.closest_similarity).toBeLessThanOrEqual(1);
  expect(decoded.furthest_similarity).toBeGreaterThanOrEqual(-1);
});

test('encoder rejects invalid inputs', () => {
  const dictionary = makeDictionary();
  const neighbors = DICT_WORDS.filter((w) => w !== 'fork').map((word) => ({ word, similarity: 0.5 }));
  const exactCount = 0;

  expect(() =>
    encodeStaticWordConfig({ word: 'missing', dictionary, neighbors, exactCount })
  ).toThrow(/missing from dictionary/);
  expect(() =>
    encodeStaticWordConfig({
      word: 'fork',
      dictionary,
      neighbors: [...neighbors, { word: 'zebra', similarity: 0.5 }],
      exactCount,
    })
  ).toThrow(/duplicate|expected/i);
  expect(() =>
    encodeStaticWordConfig({
      word: 'fork',
      dictionary,
      neighbors: neighbors.map((n) => (n.word === 'apple' ? { ...n, similarity: 1.5 } : n)),
      exactCount,
    })
  ).toThrow(/out of range/);
  expect(() =>
    encodeStaticWordConfig({
      word: 'fork',
      dictionary,
      neighbors: neighbors.map((n) => (n.word === 'apple' ? { ...n, similarity: NaN } : n)),
      exactCount,
    })
  ).toThrow(/out of range/);
});

test('DEFAULT_EXACT_COUNT matches the committed word-data', () => {
  expect(DEFAULT_EXACT_COUNT).toBe(2500);
});

// ---------------------------------------------------------------------------
// Compatibility with the committed word-data/v1 release.
// ---------------------------------------------------------------------------

function readRepoFile(relativePath: string): Uint8Array {
  const url = new URL(relativePath, import.meta.url);
  return readFileSync(fileURLToPath(url));
}

function decodeCommittedTarget(fileName: string) {
  const dictionaryBytes = readRepoFile('../../../word-data/v1/_dictionary.csv.gz');
  const dictionary = decodeStaticDictionary(dictionaryBytes);
  const targetBytes = gunzipSync(readRepoFile(`../../../word-data/v1/${fileName}`));
  const word = fileName.replace(/\.bin\.gz$/, '');
  return decodeStaticWordConfig(targetBytes, word, dictionary);
}

test('decodes the committed abbey.bin.gz with the shared decoder', () => {
  const config = decodeCommittedTarget('abbey.bin.gz');
  // Cross-check against the human-readable reference export.
  const csv = readRepoFile('../../../word-data/v1/abbey.csv')
    .toString('utf8')
    .split(/\r?\n/);
  const [, , closestRow] = csv;
  expect(closestRow).toBeDefined();
  const [closestWord, closestSim] = closestRow!.split(',');
  expect(config.closest_word).toBe(closestWord);
  expect(config.closest_similarity).toBeCloseTo(Number(closestSim), 4);
  expect(config.similar_words.length).toBe(64_638);
});
