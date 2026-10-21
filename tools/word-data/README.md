# Word-data generator (definition-based similarity)

Regenerates the static word data served from `word-data/v1/` (fetched at runtime from
`https://raw.githubusercontent.com/reddit/devvit-HotAndCold/main/word-data/v1`).

## The algorithm

The old pipeline embedded the **word surface forms** with Gemini and ranked by cosine
similarity. That rewards shared morphology (`fortnight`/`southfork` near `fork`) while
true meaning-kin words ranked lower.

The current pipeline measures **definition/meaning closeness**:

1. **Definitions** — every dictionary word gets its definition text from the Open
   English Wordnet LMF export (`tools/english-wordnet-2024.xml`, all senses, all parts
   of speech, joined with `.`). Words WordNet doesn't cover fall back to Gemini.
2. **Embeddings** — only the **definition text** is embedded (never the word) with
   `gemini-embedding-001` (3072-d).
3. **Similarity** — `similarity = cosine similarity of definition embeddings`,
   computed exactly (no ANN) in a local pgvector container.
4. **Emit** — the same static HCW2 format the app already serves
   (`<word>.bin.gz` + `_dictionary.csv.gz` + `_top25.csv.gz` + reference files), so
   there are **no runtime app changes**. After regenerating, bump
   `WORD_DATA_RELEASE` in `src/shared/wordDataVersion.ts` (done in
   `v1-full-64639-def-1`) so client IndexedDB, server Redis, and the GitHub-raw
   cache buster all invalidate.

Expected behavior: for secret `fork`, `pitchfork` ("a long-handled hand tool with
sharp, widely spaced prongs…") ranks high, `fortnight` ("a period of fourteen
consecutive days") ranks low, and words sharing an identical WordNet definition
(e.g. `couch`/`sofa`) rank at the very top.

### The 0.9999 clamp invariant

The client treats `similarity === 1` as the winning guess, and only the secret word
itself may ever see 1 (injected at render time by `renderLetterCsv`). Definition-based
similarity produces **exactly 1.0** for words sharing an identical WordNet definition
(synonyms), so the generator clamps every non-target similarity to `[-1, 0.9999]`
before encoding. 0.9999 renders as `0.9999` in the four-decimal letter CSVs and never
parses back to 1. Keep the clamp in `generate-word-data.ts` in sync with this.

## Files

| File | Step | Purpose |
| --- | --- | --- |
| `wordnet.ts` | — | Pure LMF-XML parser: `parseWordnetDefinitions` / `buildDefinitionText` |
| `build-definitions.ts` | 1 | WordNet definitions for every dictionary word → `out/definitions.csv` (`word,definition,source`) |
| `generate-missing-definitions.ts` | 2 | Gemini fallback for `source=missing` rows (a no-op while WordNet covers 100%) |
| `embed-definitions.ts` | 3 | Embed every definition → `out/definition-embeddings.csv` (resumable, append-only) |
| `generate-word-data.ts` | 4 | pgvector ranking + HCW2 encoding → `word-data/v1/` |
| `smoke-test.ts` | — | Decode/render verification of generated files (no API key, no docker) |
| `common.ts`, `gemini.ts` | — | Shared arg parsing / CSV I/O and a standalone Gemini REST client |

Outputs in `tools/word-data/out/` and `word-data/v1-smoke/` are git-ignored.

## Runbook

Requires **bun**, **Docker** (for the pgvector step), and a Google API key for steps
2–3 (step 1 is offline; step 4 needs no key once embeddings exist).

```bash
export GOOGLE_API_KEY=***   # steps 2–3 only

# 1. Definitions from WordNet (downloads the ~100 MB XML once)
bun run word-data:definitions

# 2. Gemini fallback for any missing definitions (fast no-op at 100% coverage)
bun run word-data:gemini-definitions

# 3. Embed every definition (resumable; re-run to continue after an interruption)
bun run word-data:embeddings

# 4. Rank all targets in pgvector and emit the word-data files
bun run word-data:generate --force     # --force replaces the existing word-data/v1
```

`bun run word-data:rebuild` runs steps 1–4 in order. Models are overridable via
`GEMINI_CHAT_MODEL` / `GEMINI_EMBEDDING_MODEL`; the pgvector port via
`WORD_DATA_DB_PORT` (default 55432).

### Cost / rate notes

- Step 3 embeds 64,639 texts at 100 per `batchEmbedContents` call ≈ **647 API calls**
  (RPS 2, concurrency 2, with retries). The embeddings file is append-only, so an
  interrupted run resumes where it left off.
- Step 4's long pole is the exact pgvector ranking: 2,351 targets × 64,639 words ×
  3072-d cosine similarity is **tens of minutes on a laptop**. The first run also
  writes a ~2 GB `_db-import.csv` (git-ignored, removed after the run) into
  `word-data/v1/` so the read-only container mount can COPY it.
- Step 1 re-parses the 100 MB WordNet XML (a few seconds); it is deterministic and
  only needs re-running when the dictionary or the WordNet source changes.

### Target set

Targets default to the words that already have a `.bin.gz` in `word-data/v1`
(2,351 words), so a rebuild keeps every live challenge working. Pass
`--targets <words.csv>` (any CSV with a `word` column) to add or change the set, and
`--limit N` to take the first N. `--rebuild-database` forces the pgvector table to be
reimported (needed after re-embedding or changing dimensions); otherwise a matching
table (same word count and dimension) is reused.

### Testing the mechanics without an API key

`--fake-embeddings` derives deterministic pseudo-vectors (hash-seeded from the
definition text; identical definitions still collide at the clamped 0.9999, like real
synonyms) so the whole docker/pgvector/encode/decode path can be verified cheaply:

```bash
bun run word-data:generate --fake-embeddings --limit 5 --output word-data/v1-smoke
bun run word-data:smoke               # decodes each file with the production decoder
```

The smoke test checks the full-vocabulary ranking, the ≤ 0.9999 clamp (no non-secret
similarity of 1), ordering, and renders a letter CSV through the real
`renderLetterCsv` to confirm the serving path works.

## Reference files

`word-data/v1/` also carries developer reference files that the server never serves:

- `<word>.csv` — per-target top-100 ranking (`word,similarity,rank,isHint`, rank 0 =
  the target itself). The old export had 2,501 rows per file (~176 MB of repo bloat);
  the new export keeps the top 100.
- `_top25.csv.gz` — golden `target,rank,word,similarity` top-25 rows for all targets.
- `word-list.csv`, `hints.csv`, `lemma.csv` — carried over unchanged on every rebuild
  (`hints.csv` matches the dictionary's `isHint` set; the bin.gz hints always come
  from the dictionary at decode time).
