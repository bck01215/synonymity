#!/usr/bin/env node --experimental-strip-types
/**
 * Step 3 of the definition-similarity pipeline: embed every word's
 * definition text with the Gemini embedding model.
 *
 * The embedded text is the definition only — never the word itself — which
 * is what makes the resulting similarity a measure of meaning rather than
 * surface form.
 *
 * Output is append-only and resumable: re-running skips words that already
 * have an embedding in the output file.
 *
 * Usage:
 *   export GOOGLE_API_KEY=***
 *   bun run word-data:embeddings [--definitions <definitions.csv>] [--out <embeddings.csv>]
 */
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import PQueue from 'p-queue';
import { parseArgs, readDefinitionsCsv } from './common.ts';
import { embedBatch, requireApiKey, sleep } from './gemini.ts';

const DEFAULT_DEFINITIONS = new URL('out/definitions.csv', import.meta.url);
const DEFAULT_OUT = new URL('out/definition-embeddings.csv', import.meta.url);
const BATCH_SIZE = 100; // batchEmbedContents API limit
const CONCURRENCY = 2;
const RPS = 2;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function loadExistingRows(path: string): Promise<Set<string>> {
  const done = new Set<string>();
  if (!existsSync(path)) return done;
  const rl = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line || line === 'word,embedding') continue;
    const comma = line.indexOf(',');
    if (comma === -1) continue;
    done.add(line.slice(0, comma));
  }
  return done;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), {
    definitions: { type: 'string', default: DEFAULT_DEFINITIONS.pathname },
    out: { type: 'string', default: DEFAULT_OUT.pathname },
  });
  const definitionsPath = String(args.definitions);
  const outPath = String(args.out);

  const rows = readDefinitionsCsv(definitionsPath);
  const incomplete = rows.filter((row) => !row.definition);
  if (incomplete.length > 0) {
    throw new Error(
      `${incomplete.length} words still lack definitions (e.g. ${incomplete
        .slice(0, 5)
        .map((r) => r.word)
        .join(', ')}); run word-data:gemini-definitions first`
    );
  }

  const done = await loadExistingRows(outPath);
  const todo = rows.filter((row) => !done.has(row.word));
  console.log(
    `[embeddings] ${rows.length.toLocaleString()} definitions total; ` +
      `${done.size.toLocaleString()} already embedded; ${todo.length.toLocaleString()} to go`
  );
  if (todo.length === 0) return;

  const apiKey = requireApiKey();
  const stream = createWriteStream(outPath, { encoding: 'utf8', flags: 'a' });
  if (done.size === 0) stream.write('word,embedding\n');

  const queue = new PQueue({
    concurrency: CONCURRENCY,
    intervalCap: Math.max(1, RPS),
    interval: 1000,
    carryoverIntervalCount: true,
  });
  let processed = 0;
  const batches = chunk(todo, BATCH_SIZE);
  const tasks = batches.map((batch) =>
    queue.add(async () => {
      await sleep(50 + Math.floor(Math.random() * 150));
      const vectors = await embedBatch({ apiKey, texts: batch.map((row) => row.definition) });
      for (let i = 0; i < batch.length; i++) {
        // The JSON vector contains commas, so quote it as a CSV field.
        const line = `${batch[i]!.word},"${JSON.stringify(vectors[i]!)}"`;
        if (!stream.write(line + '\n')) {
          await new Promise<void>((resolve) => stream.once('drain', resolve));
        }
      }
      processed += batch.length;
      if (processed % 1000 < BATCH_SIZE || processed === todo.length) {
        console.log(`[embeddings] ${processed.toLocaleString()} / ${todo.length.toLocaleString()}`);
      }
    })
  );
  await Promise.all(tasks);
  await new Promise<void>((resolve, reject) => {
    stream.end();
    stream.on('finish', () => resolve());
    stream.on('error', reject);
  });
  console.log(`[embeddings] done → ${outPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
