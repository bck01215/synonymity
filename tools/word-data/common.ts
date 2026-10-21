/**
 * Small shared helpers for the word-data generator scripts:
 * argument parsing, dictionary loading, and CSV I/O.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  csvField,
  decodeStaticDictionary,
} from '../../src/server/core/wordDataFormat.ts';

export type ArgSpec = Record<string, { type: 'string' | 'boolean'; default?: string }>;

export function parseArgs(argv: string[], spec: ArgSpec): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const [name, def] of Object.entries(spec)) {
    out[name] = def.type === 'boolean' ? false : (def.default ?? '');
  }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    const name = arg.replace(/^--/, '');
    if (!(name in spec)) throw new Error(`Unknown or incomplete argument: ${arg}`);
    if (spec[name]!.type === 'boolean') {
      out[name] = true;
    } else {
      const value = argv[++index];
      if (!value) throw new Error(`Unknown or incomplete argument: ${arg}`);
      out[name] = value;
    }
  }
  return out;
}

/** Load the canonical dictionary (words in id order) from `_dictionary.csv.gz`. */
export function loadDictionary(path: string): {
  words: readonly string[];
  hints: readonly boolean[];
} {
  const bytes = gunzipSync(readFileSync(path));
  const dictionary = decodeStaticDictionary(bytes);
  return { words: dictionary.words, hints: dictionary.hints };
}

export type DefinitionRow = {
  word: string;
  definition: string;
  source: 'wordnet' | 'gemini' | 'missing';
};

export const DEFINITIONS_HEADER = 'word,definition,source';

export function writeDefinitionsCsv(path: string, rows: readonly DefinitionRow[]): void {
  const lines = [
    DEFINITIONS_HEADER,
    ...rows.map((row) => `${row.word},${csvField(row.definition)},${row.source}`),
  ];
  writeFileSync(path, `${lines.join('\n')}\n`);
}

export function readDefinitionsCsv(path: string): DefinitionRow[] {
  const raw = readFileSync(path, 'utf8');
  const lines = raw.split(/\r?\n/).filter(Boolean);
  if (lines[0] !== DEFINITIONS_HEADER) throw new Error(`Unexpected definitions header in ${path}`);
  const rows: DefinitionRow[] = [];
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index]!;
    const comma = line.indexOf(',');
    const word = line.slice(0, comma);
    // Definition is the (possibly quoted) middle field; source is the last
    // unquoted token after the final comma.
    const lastComma = line.lastIndexOf(',');
    const source = line.slice(lastComma + 1);
    let definition = line.slice(comma + 1, lastComma);
    if (definition.startsWith('"') && definition.endsWith('"')) {
      definition = definition.slice(1, -1).replaceAll('""', '"');
    }
    rows.push({ word, definition, source: source as DefinitionRow['source'] });
  }
  return rows;
}

export { gzipSync };
