#!/usr/bin/env node --experimental-strip-types
/**
 * Step 4 of the definition-similarity pipeline: rank every target word
 * against the full vocabulary and emit the static word-data files.
 *
 * Similarity is the cosine similarity of the definition embeddings (see
 * embed-definitions.ts) computed exactly — no ANN — in a local pgvector
 * container started from docker-compose.word-data.yml, which mounts
 * ./word-data/${WORD_DATA_VERSION:-v1} read-only at /data.
 *
 * Gameplay invariant: the client treats similarity === 1 as the winning
 * guess, and only the secret word itself may ever see 1 (it is injected at
 * render time). Words that share an identical WordNet definition produce an
 * exact cosine of 1.0, so every non-target similarity is clamped to
 * <= 0.9999 before encoding (0.9999 renders as "0.9999" in the four-decimal
 * letter CSVs and never parses back to 1).
 *
 * Targets default to the words that already have a `.bin.gz` in
 * word-data/v1, so a rebuild keeps every live challenge working; pass
 * --targets to add or change the target set.
 *
 * Usage:
 *   bun run word-data:generate [--embeddings <csv>] [--dictionary <gz>]
 *     [--targets <csv>] [--output <dir>] [--limit N] [--concurrency N]
 *     [--force] [--keep-database-running] [--rebuild-database]
 *
 * API-key-free end-to-end mechanics check (deterministic pseudo-vectors
 * derived from the definition text; identical definitions still collide at
 * the clamped 0.9999, like real synonyms):
 *   bun run word-data:generate --fake-embeddings --limit 5 --output word-data/v1-smoke
 *   bun tools/word-data/smoke-test.ts --output word-data/v1-smoke
 */
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import PQueue from 'p-queue';
import {
  DEFAULT_EXACT_COUNT,
  csvField,
  encodeStaticDictionary,
  encodeStaticWordConfig,
  type StaticDictionary,
} from '../../src/server/core/wordDataFormat.ts';
import { gzipSync, loadDictionary, parseArgs, readDefinitionsCsv } from './common.ts';

const TOOLS_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = join(TOOLS_DIR, '..');
const COMPOSE_FILE = join(REPO_ROOT, 'docker-compose.word-data.yml');
const WORD_DATA_ROOT = join(REPO_ROOT, 'word-data');
// The pgvector container mounts ./word-data/${WORD_DATA_VERSION:-v1} read-only
// at /data, so the import CSV must be written there for the COPY to see it.
const MOUNT_DIR = join(WORD_DATA_ROOT, process.env.WORD_DATA_VERSION || 'v1');

const DB = {
  host: '127.0.0.1',
  user: 'synonymity',
  password: 'synonymity-local',
  database: 'synonymity',
};

const DEFAULT_CONCURRENCY = 4;
const REFERENCE_TOP_N = 100;
const GOLDEN_TOP_N = 25;
const FAKE_EMBEDDING_DIMENSION = 64;
/** The client wins on similarity === 1; only the secret word may reach it. */
const MAX_NON_SECRET_SIMILARITY = 0.9999;
const IMPORT_CSV_NAME = '_db-import.csv';
const REFERENCE_FILES = ['word-list.csv', 'hints.csv', 'lemma.csv'];

type Options = {
  embeddings: string;
  dictionary: string;
  targets: string;
  output: string;
  limit: number;
  force: boolean;
  keepDatabaseRunning: boolean;
  rebuildDatabase: boolean;
  fakeEmbeddings: boolean;
  definitions: string;
  concurrency: number;
};

type RankedRow = { word: string; similarity: number };

type ImportResult = {
  dimension: number;
  imported: number;
  skippedUnknown: number;
};

function parseCliArgs(argv: string[]): Options {
  const args = parseArgs(argv, {
    embeddings: {
      type: 'string',
      default: join(TOOLS_DIR, 'word-data/out/definition-embeddings.csv'),
    },
    dictionary: { type: 'string', default: join(MOUNT_DIR, '_dictionary.csv.gz') },
    targets: { type: 'string', default: '' },
    output: { type: 'string', default: MOUNT_DIR },
    limit: { type: 'string', default: '0' },
    concurrency: { type: 'string', default: String(DEFAULT_CONCURRENCY) },
    force: { type: 'boolean' },
    'keep-database-running': { type: 'boolean' },
    'rebuild-database': { type: 'boolean' },
    'fake-embeddings': { type: 'boolean' },
    definitions: { type: 'string', default: join(TOOLS_DIR, 'word-data/out/definitions.csv') },
  });
  const limit = Number.parseInt(String(args.limit), 10);
  const concurrency = Number.parseInt(String(args.concurrency), 10);
  if (!Number.isFinite(limit) || limit < 0) throw new Error('Invalid --limit value');
  if (!Number.isFinite(concurrency) || concurrency < 1) throw new Error('Invalid --concurrency');
  return {
    embeddings: resolve(String(args.embeddings)),
    dictionary: resolve(String(args.dictionary)),
    targets: args.targets ? resolve(String(args.targets)) : '',
    output: resolve(String(args.output)),
    limit,
    force: Boolean(args.force),
    keepDatabaseRunning: Boolean(args['keep-database-running']),
    rebuildDatabase: Boolean(args['rebuild-database']),
    fakeEmbeddings: Boolean(args['fake-embeddings']),
    definitions: resolve(String(args.definitions)),
    concurrency,
  };
}

function runDocker(args: string[], quiet = false): string {
  return execFileSync('docker', ['compose', '-f', COMPOSE_FILE, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: quiet ? ['ignore', 'pipe', 'pipe'] : ['inherit', 'pipe', 'inherit'],
  }).trim();
}

async function waitForDatabase(): Promise<void> {
  for (let attempt = 1; attempt <= 90; attempt++) {
    try {
      const status = runDocker(
        ['exec', '-T', 'pgvector', 'pg_isready', '-U', DB.user, '-d', DB.database],
        true
      );
      if (status.includes('accepting connections')) return;
    } catch {
      // Container is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('Timed out waiting for the pgvector container');
}

const wordFileName = (word: string): string =>
  `${encodeURIComponent(word).replaceAll("'", '%27')}.bin.gz`;
const wordReferenceFileName = (word: string): string =>
  `${encodeURIComponent(word).replaceAll("'", '%27')}.csv`;

const clampSimilarity = (value: number): number =>
  Math.min(MAX_NON_SECRET_SIMILARITY, Math.max(-1, value));

// ---------------------------------------------------------
// Pseudo-embeddings (mechanics testing without an API key)
// ---------------------------------------------------------

function hashText(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic pseudo-embedding of `text`: identical texts produce
 * identical (hence cosine-1.0) vectors, mirroring the synonym behavior of
 * the real pipeline. Only for testing the docker/pgvector/encode/decode
 * mechanics — not a meaningful similarity.
 */
function fakeEmbedding(text: string, dimension: number): number[] {
  const random = mulberry32(hashText(text));
  const vector = new Array<number>(dimension);
  let norm = 0;
  for (let index = 0; index < dimension; index++) {
    // Sum of four uniforms minus 2: roughly Gaussian on [-1, 1].
    const value = random() + random() + random() + random() - 2;
    vector[index] = value;
    norm += value * value;
  }
  const scale = Math.sqrt(norm) || 1;
  for (let index = 0; index < dimension; index++) vector[index] = vector[index]! / scale;
  return vector;
}

// ---------------------------------------------------------
// Import CSV (written into the read-only container mount)
// ---------------------------------------------------------

async function writeImportCsv(options: Options, dictionary: StaticDictionary): Promise<ImportResult> {
  const { words, hints } = dictionary;
  const wordIndex = new Map<string, number>(words.map((word, index) => [word, index]));
  const importPath = join(MOUNT_DIR, IMPORT_CSV_NAME);
  mkdirSync(MOUNT_DIR, { recursive: true });

  const stream = createWriteStream(importPath, { encoding: 'utf8' });
  const drained = (ok: boolean): Promise<void> =>
    ok
      ? Promise.resolve()
      : new Promise<void>((resolveDrain, rejectDrain) => {
          stream.once('drain', resolveDrain);
          stream.once('error', rejectDrain);
        });

  let headerWritten = false;
  let dimension = 0;
  let imported = 0;
  let skippedUnknown = 0;
  const seen = new Set<string>();

  const emitLine = async (word: string, vector: number[]): Promise<void> => {
    const id = wordIndex.get(word);
    if (id === undefined) {
      skippedUnknown++;
      return;
    }
    if (dimension === 0) dimension = vector.length;
    if (vector.length !== dimension) {
      throw new Error(
        `Embedding for "${word}" has ${vector.length} dimensions; expected ${dimension}`
      );
    }
    if (!headerWritten) {
      stream.write('word,embedding,is_hint\n');
      headerWritten = true;
    }
    seen.add(word);
    imported++;
    const line = `${word},"${JSON.stringify(vector)}",${hints[id] === true}\n`;
    await drained(stream.write(line));
  };

  if (options.fakeEmbeddings) {
    console.log('[generate] using deterministic pseudo-embeddings (fake mode)');
    const definitions = new Map<string, string>();
    if (existsSync(options.definitions)) {
      for (const row of readDefinitionsCsv(options.definitions)) {
        if (row.definition) definitions.set(row.word, row.definition);
      }
    } else {
      console.warn(
        `[generate] definitions file not found at ${options.definitions}; ` +
          'seeding pseudo-vectors from the words themselves'
      );
    }
    for (const word of words) {
      await emitLine(word, fakeEmbedding(definitions.get(word) ?? word, FAKE_EMBEDDING_DIMENSION));
    }
  } else {
    if (!existsSync(options.embeddings)) {
      throw new Error(
        `Embeddings CSV not found: ${options.embeddings}. ` +
          'Run word-data:embeddings first (or use --fake-embeddings to test mechanics).'
      );
    }
    const readStream = createReadStream(options.embeddings, { encoding: 'utf8' });
    let pending = '';
    for await (const chunk of readStream) {
      pending += chunk as string;
      let newline: number;
      while ((newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline).replace(/\r$/, '');
        pending = pending.slice(newline + 1);
        if (line.length === 0 || line === 'word,embedding') {
          continue;
        }
        const comma = line.indexOf(',');
        if (comma === -1) throw new Error(`Malformed embeddings row: ${line.slice(0, 40)}`);
        const word = line.slice(0, comma);
        const json = line.slice(comma + 1);
        if (!json.startsWith('"') || !json.endsWith('"')) {
          throw new Error(`Malformed embeddings vector for "${word}"`);
        }
        const vector = JSON.parse(json.slice(1, -1)) as number[];
        await emitLine(word, vector);
      }
    }
    if (pending.length > 0) {
      const line = pending.replace(/\r$/, '');
      const comma = line.indexOf(',');
      const word = line.slice(0, comma);
      const json = line.slice(comma + 1);
      const vector = JSON.parse(json.slice(1, -1)) as number[];
      await emitLine(word, vector);
    }
  }

  const finished = new Promise<void>((resolveEnd, rejectEnd) => {
    stream.once('finish', resolveEnd);
    stream.once('error', rejectEnd);
  });
  stream.end();
  await finished;

  const missing: string[] = [];
  for (const word of words) {
    if (!seen.has(word)) missing.push(word);
  }
  if (missing.length > 0) {
    throw new Error(
      `${missing.length.toLocaleString()} dictionary words have no embedding ` +
        `(e.g. ${missing.slice(0, 5).join(', ')}); run word-data:embeddings first`
    );
  }
  if (dimension === 0) throw new Error('No embeddings were found');
  return { dimension, imported, skippedUnknown };
}

// ---------------------------------------------------------
// Targets
// ---------------------------------------------------------

function loadDefaultTargets(): string[] {
  if (!existsSync(MOUNT_DIR)) return [];
  return readdirSync(MOUNT_DIR)
    .filter((name) => name.endsWith('.bin.gz'))
    .map((name) => decodeURIComponent(name.slice(0, -'.bin.gz'.length)))
    .sort();
}

function loadTargetsFile(path: string): string[] {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) throw new Error(`No targets found in ${path}`);
  const header = lines[0]!.split(',').map((value) => value.trim().toLowerCase());
  const wordIndex = header.findIndex((value) => value.includes('word'));
  if (wordIndex < 0) throw new Error(`No word column found in ${path}`);
  const words = lines
    .slice(1)
    .map((line) => line.split(',')[wordIndex]?.trim().toLowerCase() ?? '');
  return [...new Set(words)].filter(Boolean);
}

function resolveTargets(options: Options, dictionary: StaticDictionary): string[] {
  let targets = options.targets ? loadTargetsFile(options.targets) : loadDefaultTargets();
  if (targets.length === 0) {
    throw new Error(
      `No targets found: ${MOUNT_DIR} has no .bin.gz files and no --targets file was given`
    );
  }
  const wordSet = new Set(dictionary.words);
  const unknown = targets.filter((word) => !wordSet.has(word));
  if (unknown.length > 0) {
    throw new Error(`Targets missing from dictionary (e.g. ${unknown.slice(0, 5).join(', ')})`);
  }
  if (options.limit > 0) targets = targets.slice(0, options.limit);
  return targets;
}

// ---------------------------------------------------------
// Local pgvector database
// ---------------------------------------------------------

async function prepareDatabase(
  client: pg.Client,
  dimension: number,
  wordCount: number,
  rebuild: boolean
): Promise<void> {
  await client.query('CREATE EXTENSION IF NOT EXISTS vector');
  const relation = await client.query<{ table_name: string | null }>(
    "SELECT to_regclass('public.words')::text AS table_name"
  );
  if (!rebuild && relation.rows[0]?.table_name) {
    // format_type renders the column as e.g. "vector(64)" regardless of how
    // the pgvector version encodes the dimension in the typmod.
    const existing = await client.query<{ count: string; embedding_type: string | null }>(
      `SELECT count(*)::int AS count,
              (SELECT format_type(a.atttypid, a.atttypmod)
               FROM pg_attribute a
               WHERE a.attrelid = 'words'::regclass AND a.attname = 'embedding') AS embedding_type
       FROM words`
    );
    const count = Number(existing.rows[0]?.count);
    if (count === wordCount && existing.rows[0]?.embedding_type === `vector(${dimension})`) {
      console.log(
        `[generate] reusing the existing ${wordCount.toLocaleString()} x ${dimension} pgvector index ` +
          '(pass --rebuild-database to force a reimport)'
      );
      return;
    }
  }

  console.log(
    `[generate] loading ${wordCount.toLocaleString()} x ${dimension} embeddings into the local pgvector index…`
  );
  await client.query(`
    DROP TABLE IF EXISTS words;
    CREATE TABLE words (
      word text PRIMARY KEY,
      embedding vector(${dimension}) NOT NULL,
      is_hint boolean NOT NULL
    );
    COPY words FROM '/data/${IMPORT_CSV_NAME}' WITH (FORMAT csv, HEADER true);
    ANALYZE words;
  `);
  const result = await client.query<{ count: string }>('SELECT count(*)::int AS count FROM words');
  const count = Number(result.rows[0]?.count);
  if (count !== wordCount) {
    throw new Error(`pgvector index has ${count.toLocaleString()} words; expected ${wordCount.toLocaleString()}`);
  }
  console.log('[generate] local pgvector index is ready');
}

// ---------------------------------------------------------
// Main
// ---------------------------------------------------------

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));
  const staging = `${options.output}.tmp-${process.pid}`;
  try {
    await generate(options, staging);
  } catch (error) {
    // Never leave a partial staging dir behind (git-ignored, but still cruft).
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

async function generate(options: Options, staging: string): Promise<void> {
  const dictionary = loadDictionary(options.dictionary);
  const { words, hints } = dictionary;
  const hintByWord = new Map<string, boolean>(words.map((word, index) => [word, hints[index] === true]));
  const hintCount = [...hintByWord.values()].filter(Boolean).length;
  console.log(
    `[generate] dictionary: ${words.length.toLocaleString()} words, ${hintCount.toLocaleString()} hints`
  );

  const targets = resolveTargets(options, dictionary);
  console.log(
    `[generate] ${targets.length.toLocaleString()} targets` +
      (options.limit > 0 ? ` (limited from a larger set)` : '')
  );

  if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  // Refuse to clobber existing word data without an explicit --force.
  const existingWordFiles = existsSync(options.output)
    ? readdirSync(options.output).filter((name) => name.endsWith('.bin.gz')).length
    : 0;
  if (existingWordFiles > 0 && !options.force) {
    rmSync(staging, { recursive: true, force: true });
    throw new Error(
      `${options.output} already contains ${existingWordFiles.toLocaleString()} word files; ` +
        'pass --force to replace them (or use a different --output for a partial run)'
    );
  }

  // Non-target reference files carried over from the current output dir.
  for (const name of REFERENCE_FILES) {
    const source = join(options.output, name);
    if (existsSync(source)) cpSync(source, join(staging, name));
  }

  // Re-emit the dictionary (unchanged content, same format).
  writeFileSync(join(staging, '_dictionary.csv.gz'), encodeStaticDictionary(dictionary));

  const importResult = await writeImportCsv(options, dictionary);
  console.log(
    `[generate] import CSV: ${importResult.imported.toLocaleString()} rows x ` +
      `${importResult.dimension} dimensions → ${join(MOUNT_DIR, IMPORT_CSV_NAME)}`
  );
  if (importResult.skippedUnknown > 0) {
    console.warn(
      `[generate] skipped ${importResult.skippedUnknown.toLocaleString()} embeddings for words outside the dictionary`
    );
  }

  runDocker(['up', '-d', 'pgvector']);
  await waitForDatabase();
  const port = Number.parseInt(process.env.WORD_DATA_DB_PORT || '55432', 10);
  const bootstrap = new pg.Client({
    host: DB.host,
    port,
    user: DB.user,
    password: DB.password,
    database: DB.database,
  });
  await bootstrap.connect();
  try {
    await prepareDatabase(bootstrap, importResult.dimension, words.length, options.rebuildDatabase);
  } finally {
    await bootstrap.end();
  }

  const pool = new pg.Pool({
    host: DB.host,
    port,
    user: DB.user,
    password: DB.password,
    database: DB.database,
    max: options.concurrency,
  });
  const queue = new PQueue({ concurrency: options.concurrency });
  const goldenRows = ['target,rank,word,similarity'];
  // Set by whichever task finishes first (control-flow narrowing does not
  // track assignments inside async closures, hence the container object).
  const topNeighbors = new Map<string, string>();
  let complete = 0;
  const startedAt = Date.now();

  const tasks = targets.map((target) =>
    queue.add(async () => {
      const result = await pool.query<RankedRow>(
        `SELECT w.word,
                1 - (w.embedding <=> target.embedding) AS similarity
         FROM words w
         CROSS JOIN (SELECT embedding FROM words WHERE word = $1) target
         WHERE w.word <> $1
         ORDER BY w.embedding <=> target.embedding, w.word`,
        [target]
      );
      const neighbors = result.rows.map((row) => ({
        word: row.word,
        similarity: clampSimilarity(row.similarity),
      }));

      writeFileSync(
        join(staging, wordFileName(target)),
        encodeStaticWordConfig({
          word: target,
          dictionary,
          neighbors,
          exactCount: Math.min(DEFAULT_EXACT_COUNT, neighbors.length),
        })
      );

      // Developer reference CSV (top 100); the server never serves these.
      const referenceLines = [
        'word,similarity,rank,isHint',
        `${csvField(target)},1,0,${hintByWord.get(target) === true}`,
      ];
      for (let index = 0; index < Math.min(REFERENCE_TOP_N, neighbors.length); index++) {
        const row = neighbors[index]!;
        referenceLines.push(
          `${csvField(row.word)},${row.similarity},${index + 1},${hintByWord.get(row.word) === true}`
        );
      }
      writeFileSync(join(staging, wordReferenceFileName(target)), `${referenceLines.join('\n')}\n`);

      for (let index = 0; index < Math.min(GOLDEN_TOP_N, neighbors.length); index++) {
        const row = neighbors[index]!;
        goldenRows.push(`${csvField(target)},${index + 1},${csvField(row.word)},${row.similarity}`);
      }

      if (topNeighbors.size === 0) {
        topNeighbors.set(
          target,
          neighbors
            .slice(0, 3)
            .map((row) => `${row.word} (${row.similarity.toFixed(4)})`)
            .join(', ')
        );
      }
      complete++;
      if (complete === targets.length || complete % 25 === 0) {
        const elapsedSeconds = Math.max(1, (Date.now() - startedAt) / 1000);
        const rate = complete / elapsedSeconds;
        const remainingMinutes = (targets.length - complete) / Math.max(rate, 0.001) / 60;
        console.log(
          `[generate] ${complete.toLocaleString()} / ${targets.length.toLocaleString()} targets ` +
            `(${remainingMinutes.toFixed(1)} minutes remaining)`
        );
      }
    })
  );

  try {
    await Promise.all(tasks);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  } finally {
    await pool.end();
    if (!options.keepDatabaseRunning) runDocker(['stop', 'pgvector']);
  }

  writeFileSync(join(staging, '_top25.csv.gz'), gzipSync(`${goldenRows.join('\n')}\n`, { level: 9 }));

  // If the embeddings input lives inside the directory we are about to
  // replace, move it out now (after it has been read) so the atomic swap
  // does not destroy it.
  if (
    !options.fakeEmbeddings &&
    existsSync(options.embeddings) &&
    options.embeddings.startsWith(options.output + '/')
  ) {
    const backupDir = join(TOOLS_DIR, 'word-data/out');
    mkdirSync(backupDir, { recursive: true });
    const backupPath = join(backupDir, basename(options.embeddings));
    console.warn(`[generate] embeddings input is inside the output dir; moving it to ${backupPath}`);
    rmSync(backupPath, { force: true });
    renameSync(options.embeddings, backupPath);
  }

  // Atomic swap: the old output dir (including the import CSV) is removed
  // only after the full staging dir is built.
  if (existsSync(options.output)) {
    rmSync(options.output, { recursive: true, force: true });
  }
  renameSync(staging, options.output);

  // Clean up the import CSV from the container mount (a no-op when the
  // mount dir was the output dir, which the swap already replaced).
  rmSync(join(MOUNT_DIR, IMPORT_CSV_NAME), { force: true });

  const [summaryTarget, summaryTop] = topNeighbors.entries().next().value ?? [];
  console.log(
    `[generate] wrote ${targets.length.toLocaleString()} word files to ${options.output}` +
      (summaryTarget ? ` — top neighbors of "${summaryTarget}": ${summaryTop}` : '')
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
