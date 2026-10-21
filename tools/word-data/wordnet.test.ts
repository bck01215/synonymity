import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect, describe } from 'vitest';
import { buildDefinitionText, parseWordnetDefinitions, unescapeXml } from './wordnet.ts';

const SYNTHETIC_XML = `<?xml version="1.0" encoding="UTF-8"?>
<LexicalResource>
  <Lexicon id="test">
    <LexicalEntry id="t-fork-n">
      <Lemma writtenForm="fork" partOfSpeech="n"/>
      <Sense id="s1" synset="oewn-111-n"/>
      <Sense id="s2" synset="oewn-222-n"/>
    </LexicalEntry>
    <LexicalEntry id="t-fork-v">
      <Lemma writtenForm="Fork" partOfSpeech="v"/>
      <Sense id="s3" synset="oewn-222-n"/>
      <Sense id="s4" synset="oewn-333-v"/>
    </LexicalEntry>
    <LexicalEntry id="t-pitchfork-n">
      <Lemma writtenForm="pitchfork" partOfSpeech="n"/>
      <Sense id="s5" synset="oewn-444-n"/>
    </LexicalEntry>
    <LexicalEntry id="t-odd-a">
      <Lemma writtenForm="o&apos;d" partOfSpeech="a"/>
      <Sense id="s6" synset="oewn-555-a"/>
    </LexicalEntry>
    <LexicalEntry id="t-nodef-n">
      <Lemma writtenForm="nodef" partOfSpeech="n"/>
      <Sense id="s7" synset="oewn-666-n"/>
    </LexicalEntry>
    <Synset id="oewn-111-n" partOfSpeech="n" members="oewn-fork-n">
      <Definition>a utensil with two or more prongs</Definition>
    </Synset>
    <Synset id="oewn-222-n" partOfSpeech="n">
      <Definition>the act of branching out</Definition>
      <Example>the fork in the road</Example>
    </Synset>
    <Synset id="oewn-333-v" partOfSpeech="v">
      <Definition>to turn out of one&rsquo;s course</Definition>
    </Synset>
    <Synset id="oewn-444-n" partOfSpeech="n">
      <Definition>a long-handled tool with sharp prongs</Definition>
    </Synset>
    <Synset id="oewn-555-a" partOfSpeech="a">
      <Definition>not divisible by two</Definition>
    </Synset>
    <Synset id="oewn-666-n" partOfSpeech="n">
      <Example>no definition here</Example>
    </Synset>
  </Lexicon>
</LexicalResource>`;

test('unescapeXml decodes named and numeric entities', () => {
  expect(unescapeXml('a&apos;b &amp; c &lt;d&gt; &#x263A;')).toBe('a\'b & c <d> ☺');
  expect(unescapeXml('no entities')).toBe('no entities');
});

test('parses lemmas across parts of speech with deduplication', () => {
  const definitions = parseWordnetDefinitions(SYNTHETIC_XML);

  expect([...definitions.get('fork')!]).toEqual([
    'a utensil with two or more prongs',
    'the act of branching out',
    'to turn out of one’s course',
  ]);
  expect([...definitions.get('pitchfork')!]).toEqual(['a long-handled tool with sharp prongs']);
  expect([...definitions.get("o'd")!]).toEqual(['not divisible by two']);
  // Synsets without a Definition produce no entry.
  expect(definitions.has('nodef')).toBe(false);
});

test('buildDefinitionText joins senses and handles missing definitions', () => {
  expect(buildDefinitionText(['a utensil', 'branching'])).toBe('a utensil. branching');
  expect(buildDefinitionText([])).toBe('');
  expect(buildDefinitionText(undefined)).toBe('');
});

// ---------------------------------------------------------------------------
// Real WordNet (tools/english-wordnet-2024.xml). The file is large and
// git-ignored; the generator downloads it on demand, so skip when absent.
// ---------------------------------------------------------------------------

const WORDNET_XML = fileURLToPath(new URL('../english-wordnet-2024.xml', import.meta.url));

describe('real WordNet definitions', () => {
  test.skipIf(!existsSync(WORDNET_XML))('fork vs pitchfork vs fortnight meanings', () => {
    const definitions = parseWordnetDefinitions(readFileSync(WORDNET_XML, 'utf8'));

    const fork = buildDefinitionText(definitions.get('fork'));
    const pitchfork = buildDefinitionText(definitions.get('pitchfork'));
    const fortnight = buildDefinitionText(definitions.get('fortnight'));

    // Both forks are eating/lifting pronged utensils in meaning.
    expect(fork).toMatch(/prong/);
    expect(fork).toMatch(/utensil/);
    expect(pitchfork).toMatch(/prong/);

    // Fortnight is a unit of time; its definition shares none of the
    // surface form of "fork".
    expect(fortnight.length).toBeGreaterThan(0);
    expect(fortnight).not.toMatch(/prong|utensil|fork/);
  }, 120_000);
});
