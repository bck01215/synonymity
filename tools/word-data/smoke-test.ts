#!/usr/bin/env node --experimental-strip-types
/**
 * End-to-end smoke test for generated word-data (no API key required).
 *
 * Decodes every `<word>.bin.gz` in the output dir with the production
 * decoder, verifies the invariants the serving path depends on, and
 * renders a letter CSV through the real renderLetterCsv to confirm the
 * decoded config flows through the serving code unchanged.
 *
 * Invariants checked per file:
 *   - the file decodes against the committed dictionary
 *   - it ranks every other dictionary word exactly once
 *   - no non-secret similarity is 1 or above 0.9999 (the client wins on
 *     similarity === 1, which only the injected secret row may have)
 *   - the closest word is not the target itself
 *   - similarities are ordered closest to furthest (quantization tolerance)
 *   - the rendered letter CSV has the header, the secret row at rank 0 with
 *     similarity 1.0000, and no other row rendering as 1.0000
 *
 * Usage:
 *   bun tools/word-data/generate-word-data.ts --fake-embeddings --limit 5 --output word-data/v1-smoke
 *   bun tools/word-data/smoke-test.ts --output word-data/v1-smoke
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decodeStaticDictionary,
  decodeStaticWordConfig,
  renderLetterCsv,
  type StaticDictionary,
} from '../../src/server/core/wordDataFormat.ts';
import { parseArgs } from './common.ts';

const REPO_ROOT = join(dirname(dirname(fileURLToPath(import.meta.url))), '..');
const MAX_NON_SECRET_SIMILARITY = 0.9999;
// Quantized rows (int16 / 10000) may round up to within 5e-5 of the
// preceding exact float64 row, so ordering checks allow that tolerance.
const ORDERING_TOLERANCE = 1e-4;

function checkFile(outputDir: string, fileName: string, dictionary: StaticDictionary): void {
  const word = decodeURIComponent(fileName.slice(0, -'.bin.gz'.length));
  const config = decodeStaticWordConfig(readFileSync(join(outputDir, fileName)), word, dictionary);

  if (config.similar_words.length !== dictionary.words.length - 1) {
    throw new Error(
      `${word}: expected ${dictionary.words.length - 1} neighbors, got ${config.similar_words.length}`
    );
  }
  if (config.closest_word === word) {
    throw new Error(`${word}: closest word is the target itself`);
  }

  let previous = Infinity;
  for (const entry of config.similar_words) {
    if (entry.similarity > MAX_NON_SECRET_SIMILARITY) {
      throw new Error(
        `${word}: non-secret similarity too high for ${entry.word}: ${entry.similarity}`
      );
    }
    if (entry.similarity > previous + ORDERING_TOLERANCE) {
      throw new Error(
        `${word}: ranking not ordered at ${entry.word} (${entry.similarity} after ${previous})`
      );
    }
    previous = entry.similarity;
  }

  const letterCsv = renderLetterCsv(word, word.charAt(0), config);
  const lines = letterCsv.split('\n');
  if (lines[0] !== 'word,similarity,rank') {
    throw new Error(`${word}: unexpected letter CSV header: ${lines[0]}`);
  }
  if (!lines.includes(`${word},1.0000,0`)) {
    throw new Error(`${word}: secret row (similarity 1.0000, rank 0) missing from letter CSV`);
  }
  for (const line of lines.slice(1)) {
    const [lineWord, similarity] = line.split(',');
    if (similarity === '1.0000' && lineWord !== word) {
      throw new Error(`${word}: letter CSV renders non-secret ${lineWord} as 1.0000`);
    }
  }

  const top = config.similar_words
    .slice(0, 3)
    .map((entry) => `${entry.word} (${entry.similarity.toFixed(4)})`)
    .join(', ');
  console.log(
    `[smoke] ${word}: OK — closest: ${top}; letter CSV ${lines.length - 1} rows`
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), {
    output: { type: 'string', default: join(REPO_ROOT, 'word-data/v1-smoke') },
  });
  const outputDir = String(args.output);
  if (!existsSync(outputDir)) throw new Error(`Output dir not found: ${outputDir}`);

  const dictionary = decodeStaticDictionary(readFileSync(join(outputDir, '_dictionary.csv.gz')));
  console.log(`[smoke] dictionary: ${dictionary.words.length.toLocaleString()} words`);

  const files = readdirSync(outputDir).filter((name) => name.endsWith('.bin.gz'));
  if (files.length === 0) throw new Error(`No .bin.gz files in ${outputDir}`);

  for (const fileName of files) {
    checkFile(outputDir, fileName, dictionary);
  }
  console.log(`[smoke] all ${files.length} files pass`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
