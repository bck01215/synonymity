#!/usr/bin/env node --experimental-strip-types
/**
 * Step 2 of the definition-similarity pipeline: fill in the definitions that
 * WordNet did not cover (`source=missing`) using Gemini.
 *
 * The dictionary is currently 100% covered by WordNet, so this step is a
 * fast no-op unless the dictionary grows or the WordNet source changes.
 *
 * Usage:
 *   export GOOGLE_API_KEY=***
 *   bun run word-data:gemini-definitions [--out <definitions.csv>]
 */
import PQueue from 'p-queue';
import {
  parseArgs,
  readDefinitionsCsv,
  writeDefinitionsCsv,
  type DefinitionRow,
} from './common.ts';
import { generateContent, requireApiKey } from './gemini.ts';

const DEFAULT_OUT = new URL('out/definitions.csv', import.meta.url);

const SYSTEM_PROMPT = [
  'You are a lexicographer.',
  'Given a single word, write one concise dictionary-style definition sentence',
  'that captures its primary meaning in American English.',
  'One sentence only. No etymology, no examples, no headings.',
  'If the word has multiple meanings, define the most common one.',
].join(' ');

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), {
    out: { type: 'string', default: DEFAULT_OUT.pathname },
  });
  const outPath = String(args.out);
  const rows = readDefinitionsCsv(outPath);
  const missing = rows.filter((row) => row.source === 'missing');

  if (missing.length === 0) {
    console.log(`[gemini-definitions] nothing to do: all ${rows.length.toLocaleString()} words have definitions`);
    return;
  }

  const apiKey = requireApiKey();
  console.log(
    `[gemini-definitions] generating ${missing.length.toLocaleString()} missing definitions ` +
      `(${(100 * (missing.length / rows.length)).toFixed(1)}% of dictionary)`
  );

  const byWord = new Map(rows.map((row) => [row.word, row]));
  const queue = new PQueue({ concurrency: 4 });
  const tasks = missing.map((row) =>
    queue.add(async () => {
      const text = await generateContent({
        apiKey,
        system: SYSTEM_PROMPT,
        user: `Word: ${row.word}`,
        responseJsonSchema: {
          type: 'object',
          properties: { definition: { type: 'string', description: 'one-sentence definition' } },
          required: ['definition'],
        },
      });
      let definition = text.trim();
      try {
        const parsed = JSON.parse(definition) as { definition?: unknown };
        if (typeof parsed.definition === 'string') definition = parsed.definition.trim();
      } catch {
        // Keep the raw text when the model ignored JSON mode.
      }
      if (!definition) throw new Error(`empty definition for ${row.word}`);
      const updated: DefinitionRow = { word: row.word, definition, source: 'gemini' };
      byWord.set(row.word, updated);
      console.log(`[gemini-definitions] ${row.word}: ${definition.slice(0, 80)}`);
    })
  );
  await Promise.all(tasks);

  const order = new Map(rows.map((row, index) => [row.word, index]));
  const merged = [...byWord.values()].sort(
    (a, b) => (order.get(a.word) ?? 0) - (order.get(b.word) ?? 0)
  );
  writeDefinitionsCsv(outPath, merged);
  console.log(`[gemini-definitions] updated ${outPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
