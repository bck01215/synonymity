#!/usr/bin/env node --experimental-strip-types
/**
 * Step 1 of the definition-similarity pipeline: build `definitions.csv`.
 *
 * For every word in the canonical dictionary, collect its definition text
 * from the Open English Wordnet LMF export. Words without a WordNet
 * definition are marked `source=missing` for step 2 (Gemini fallback).
 *
 * Usage:
 *   bun run word-data:definitions [--dictionary <path>] [--xml <path>] [--out <path>]
 *
 * The WordNet XML (~100 MB) is downloaded automatically from the official
 * release on first run and cached next to this script.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
  loadDictionary,
  parseArgs,
  writeDefinitionsCsv,
  type DefinitionRow,
} from './common.ts';
import { buildDefinitionText, parseWordnetDefinitions } from './wordnet.ts';

const TOOLS_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = join(TOOLS_DIR, '..');

const WORDNET_VERSION = '2024';
const WORDNET_URL =
  'https://github.com/globalwordnet/english-wordnet/releases/download/' +
  `${WORDNET_VERSION}-edition/english-wordnet-${WORDNET_VERSION}.xml.gz`;
const DEFAULT_XML = join(TOOLS_DIR, `english-wordnet-${WORDNET_VERSION}.xml`);
const DEFAULT_DICTIONARY = join(REPO_ROOT, 'word-data/v1/_dictionary.csv.gz');
const DEFAULT_OUT = join(TOOLS_DIR, 'word-data/out/definitions.csv');

async function ensureWordnetXml(path: string): Promise<void> {
  if (existsSync(path)) return;
  console.log(`[definitions] downloading WordNet ${WORDNET_VERSION} (~100 MB) → ${path}`);
  const response = await fetch(WORDNET_URL);
  if (!response.ok) {
    throw new Error(`WordNet download failed: HTTP ${response.status} for ${WORDNET_URL}`);
  }
  const compressed = Buffer.from(await response.arrayBuffer());
  writeFileSync(`${path}.gz`, compressed);
  writeFileSync(path, gunzipSync(compressed));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), {
    dictionary: { type: 'string', default: DEFAULT_DICTIONARY },
    xml: { type: 'string', default: DEFAULT_XML },
    out: { type: 'string', default: DEFAULT_OUT },
  });

  const startedAt = Date.now();
  await ensureWordnetXml(String(args.xml));
  const xml = readFileSync(String(args.xml), 'utf8');

  console.log(`[definitions] parsing WordNet (${(xml.length / 1e6).toFixed(1)} MB)…`);
  const definitions = parseWordnetDefinitions(xml);
  console.log(`[definitions] ${definitions.size.toLocaleString()} lemmas with definitions`);

  const { words } = loadDictionary(String(args.dictionary));
  const rows: DefinitionRow[] = words.map((word) => {
    const text = buildDefinitionText(definitions.get(word));
    return text
      ? { word, definition: text, source: 'wordnet' as const }
      : { word, definition: '', source: 'missing' as const };
  });

  mkdirSync(dirname(String(args.out)), { recursive: true });
  writeDefinitionsCsv(String(args.out), rows);

  const covered = rows.filter((row) => row.source === 'wordnet').length;
  const missing = rows.length - covered;
  console.log(
    `[definitions] wrote ${rows.length.toLocaleString()} rows to ${args.out} ` +
      `(${(100 * (covered / rows.length)).toFixed(1)}% covered by WordNet, ` +
      `${missing.toLocaleString()} missing → need Gemini in step 2)`
  );
  if (missing > 0) {
    console.log(
      `[definitions] sample missing: ${rows
        .filter((row) => row.source === 'missing')
        .slice(0, 15)
        .map((row) => row.word)
        .join(', ')}`
    );
  }
  console.log(
    `[definitions] done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
