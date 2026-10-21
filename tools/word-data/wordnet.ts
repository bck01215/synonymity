/**
 * WordNet (LMF XML) definition extraction.
 *
 * Pure, dependency-free parsing of the Open English Wordnet LMF export into a
 * `lemma -> definitions` map. Each definition is the `<Definition>` text of a
 * synset reachable from the lemma, across all parts of speech, in XML order.
 */

/** lemma (lowercase writtenForm) -> definitions, one per sense, in XML order */
export type WordnetDefinitions = Map<string, readonly string[]>;

const XML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  // Typographic entities used by the WordNet LMF export.
  rsquo: '\u2019',
  lsquo: '\u2018',
  rdquo: '\u201D',
  ldquo: '\u201C',
  ndash: '\u2013',
  mdash: '\u2014',
  hellip: '\u2026',
  eacute: 'é',
  egrave: 'è',
  iacute: 'í',
  oacute: 'ó',
  uacute: 'ú',
  auml: 'ä',
  ouml: 'ö',
  uml: 'ü',
};

/** Decode XML character references and named entities. */
export function unescapeXml(text: string): string {
  return text.replace(
    /&#x([0-9a-fA-F]+);|&#(\d+);|&([a-zA-Z][a-zA-Z0-9]*);/g,
    (match, hex?: string, dec?: string, name?: string) => {
      if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
      if (dec) return String.fromCodePoint(Number.parseInt(dec, 10));
      return (name && XML_ENTITIES[name]) || match;
    },
  );
}

/** Extract an attribute value from a raw opening tag string. */
function attributeValue(tag: string, name: string): string | null {
  const match = new RegExp(`${name}="([^"]*)"`).exec(tag);
  return match ? unescapeXml(match[1]!) : null;
}

/** Find all opening tags of a given element inside a block. */
function openingTags(block: string, element: string): string[] {
  const tags: string[] = [];
  const open = `<${element}`;
  let index = 0;
  while (true) {
    const start = block.indexOf(open, index);
    if (start === -1) break;
    // The marker includes '<', so the character after the element name sits
    // at start + 1 + element.length; it must be whitespace or '>'.
    const afterName = start + 1 + element.length;
    if (block[afterName] !== ' ' && block[afterName] !== '>') {
      index = start + 1;
      continue;
    }
    const end = block.indexOf('>', start);
    if (end === -1) break;
    tags.push(block.slice(start, end + 1));
    index = end + 1;
  }
  return tags;
}

/** First `<element>…</element>` text payload in a block (null when absent). */
function elementText(block: string, element: string): string | null {
  const open = `<${element}>`;
  const start = block.indexOf(open);
  if (start === -1) return null;
  const end = block.indexOf(`</${element}>`, start);
  if (end === -1) return null;
  return unescapeXml(block.slice(start + open.length, end)).trim();
}

/**
 * Parse the full WordNet LMF document into `lemma -> definitions`.
 *
 * Two streaming scans over the raw XML (no DOM): synsets first, then lexical
 * entries. A 100 MB document parses in a few seconds and ~1 GB of heap.
 */
export function parseWordnetDefinitions(xml: string): WordnetDefinitions {
  // Pass 1: synset id -> definition text
  const synsetDefinitions = new Map<string, string>();
  const synsetOpen = '<Synset ';
  const synsetClose = '</Synset>';
  let cursor = 0;
  while (true) {
    const start = xml.indexOf(synsetOpen, cursor);
    if (start === -1) break;
    const end = xml.indexOf(synsetClose, start);
    if (end === -1) break;
    const block = xml.slice(start, end + synsetClose.length);
    const id = attributeValue(block.slice(0, block.indexOf('>')), 'id');
    const definition = elementText(block, 'Definition');
    if (id && definition) synsetDefinitions.set(id, definition);
    cursor = end + synsetClose.length;
  }

  // Pass 2: lemma -> synset ids (in order, deduplicated)
  const lemmaSynsets = new Map<string, string[]>();
  const entryOpen = '<LexicalEntry ';
  const entryClose = '</LexicalEntry>';
  cursor = 0;
  while (true) {
    const start = xml.indexOf(entryOpen, cursor);
    if (start === -1) break;
    const end = xml.indexOf(entryClose, start);
    if (end === -1) break;
    const block = xml.slice(start, end + entryClose.length);

    const lemmaTags = openingTags(block, 'Lemma');
    const lemma = lemmaTags.length > 0 ? attributeValue(lemmaTags[0]!, 'writtenForm') : null;
    if (!lemma) {
      cursor = end + entryClose.length;
      continue;
    }
    const key = lemma.trim().toLowerCase();

    let synsets = lemmaSynsets.get(key);
    if (!synsets) {
      synsets = [];
      lemmaSynsets.set(key, synsets);
    }
    for (const senseTag of openingTags(block, 'Sense')) {
      const synsetId = attributeValue(senseTag, 'synset');
      if (synsetId && !synsets.includes(synsetId)) synsets.push(synsetId);
    }
    cursor = end + entryClose.length;
  }

  // Join: lemma -> definitions
  const definitions: WordnetDefinitions = new Map();
  for (const [lemma, synsets] of lemmaSynsets) {
    const texts: string[] = [];
    for (const synsetId of synsets) {
      const definition = synsetDefinitions.get(synsetId);
      if (definition && !texts.includes(definition)) texts.push(definition);
    }
    if (texts.length > 0) definitions.set(lemma, texts);
  }
  return definitions;
}

/**
 * Build the single text that gets embedded for a word: all of its WordNet
 * definitions joined into one passage. Empty string when the word has no
 * definitions (callers fill those in with generated definitions).
 */
export function buildDefinitionText(definitions: readonly string[] | undefined): string {
  if (!definitions || definitions.length === 0) return '';
  return definitions.join('. ');
}
