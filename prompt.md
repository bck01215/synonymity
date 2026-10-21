# Handoff prompt — Synonymity: definition-based word similarity

You are continuing work in `devvit-Synonymity` (a Devvit Reddit bot; local clone of the
`reddit/devvit-HotAndCold` upstream that the bot serves its static word-data from).

## The task

Change the word-closeness algorithm **solely to definition/meaning closeness**.

The old algorithm (removed from the repo in commit `0623eb4`, viewable via
`git show 0623eb4^:tools/generate-full-word-data.ts`) embedded the **word surface
forms** with Gemini (`gemini-embedding-001`, 3072-d) and used pgvector cosine
similarity. That makes `fortnight`/`southfork` rank close to `fork` (shared
morphology) while true meaning-kin words rank lower. The new algorithm must:

1. Get a **definition** for every dictionary word (Open English WordNet LMF XML;
   Gemini fallback for gaps).
2. Embed **the definition text only** (never the word) with the Gemini embedding model.
3. `similarity = cosine similarity of definition embeddings`.
4. Emit the **same static HCW2 format** the app already serves (no runtime app changes),
   then bump `WORD_DATA_RELEASE` so all caches invalidate.

Expected behavior once regenerated: for secret `fork`, `pitchfork` ("a long-handled
hand tool with sharp widely spaced prongs…") ranks high, `fortnight` ("a period of
fourteen consecutive days") ranks low, and true synonyms (e.g. `couch`/`sofa` share an
identical WordNet definition) rank at the very top.

## Environment (already set up — do not redo)

- **bun** is the package manager (AGENTS.md says so). `bun install`, `bun run <script>`,
  `bun run test`. **Do NOT use `bun test`** (that is bun's native runner; the repo's
  script `bun run test` runs vitest).
- Node v26.12.0 via `.nvmrc` (bumped from 22.18.0; installed via `proto install node 26.12.0`).
- `bun.lock` is the lockfile; `package-lock.json` was deleted.
- Server tests need system redis (valkey at `/opt/homebrew/bin/redis-server`);
  `src/server/vitest-redis-setup.ts` auto-detects it. `package.json` has
  `"redisMemoryServer": { "disablePostinstall": true }` (the source-build postinstall
  fails on macOS's old make).
- Client browser tests use system Google Chrome: `src/client/vitest.config.ts` has
  `instances: [{ browser: 'chromium', launch: { channel: 'chrome' } }]`. Verified via
  debug log: `launch options: { channel: 'chrome', headless: true }`.
- Docker is available (needed for the pgvector step below).
- **No `GOOGLE_API_KEY` in this environment** — the Gemini steps (definitions fallback,
  embeddings) cannot be executed here; they must be run by the user with a key.
- WordNet XML is at `tools/english-wordnet-2024.xml` (102 MB, git-ignored; restored from
  git history; upstream release `https://github.com/globalwordnet/english-wordnet/releases/download/2024-edition/english-wordnet-2024.xml.gz`
  is byte-identical except one label typo — `build-definitions.ts` auto-downloads it if absent).

## What is DONE (verified)

### App-side (all app tests pass: `bun run test` → 197/198; the 1 failure is fixed now, re-run to confirm)

- `src/server/core/wordDataFormat.ts` — **new** pure HCW2 codec (encode + decode), no
  devvit/network deps. `encodeStaticWordConfig` (new) + `encodeStaticDictionary` (new) +
  the decoders moved from `staticWordData.ts`. Constants: MAGIC `HCW2`, header 12 bytes,
  exact rows 10 bytes (float64), quantized rows 4 bytes (int16/10000), `DEFAULT_EXACT_COUNT = 2500`.
- `src/server/core/staticWordData.ts` — refactored to import/re-export from
  `wordDataFormat.ts`; public API unchanged.
- `src/server/core/wordDataFormat.test.ts` — 6 tests incl. round-trip and a
  compatibility test that decodes the committed `word-data/v1/abbey.bin.gz` and cross-checks
  it against `abbey.csv` (passes → format is byte-compatible with existing data).
- `AGENTS.md`, `.gitignore`, `.nvmrc`, `package.json` (bun, `packageManager`, redisMemoryServer,
  `bun run` in deploy/launch scripts) — updated.

### Generator pipeline (`tools/word-data/`, partially complete)

- `wordnet.ts` — pure LMF-XML parser: `parseWordnetDefinitions(xml) → Map<lemma, string[]>`
  (all senses, all POS, deduped, in XML order) + `buildDefinitionText()` (joins with `. `)
  + `unescapeXml()`. **Tests pass** (`wordnet.test.ts`, incl. real-XML fork/pitchfork/fortnight
  assertions; the real-XML test skips if the 102 MB XML is absent).
- `common.ts` — arg parsing, `loadDictionary()` (uses `decodeStaticDictionary`), definitions
  CSV read/write (`word,definition,source` with source ∈ wordnet|gemini|missing).
- `build-definitions.ts` — **ran successfully**: 64,639/64,639 dictionary words covered by
  WordNet (100%, 0 missing) → `tools/word-data/out/definitions.csv` (git-ignored).
- `gemini.ts` — standalone Gemini REST client (fetch only): `generateContent`
  (gemini-3.6-flash, JSON schema mode) + `embedBatch` (`batchEmbedContents`, model
  `gemini-embedding-001`, ≤100 texts/call) with exponential-backoff retries. Reads
  `GOOGLE_API_KEY`/`GENAI_API_KEY`; models overridable via `GEMINI_CHAT_MODEL` /
  `GEMINI_EMBEDDING_MODEL`.
- `generate-missing-definitions.ts` — step 2 (Gemini fallback for `source=missing` rows).
  Currently a no-op (0 missing) but needed for dictionary growth.
- `embed-definitions.ts` — step 3: embeds every definition (batch 100, RPS 2, resumable
  append-only CSV `out/definition-embeddings.csv`, `word,"[...json...]"` with the vector
  CSV-quoted). **Not yet run** (needs API key).
- `tools/tsconfig.json` + `tools/vitest.config.ts`; root `tsconfig.json` references `./tools`
  and root `vitest.config.ts` has `projects: ['src/*', 'tools']`.
- Installed devDeps: `p-queue`, `pg`, `@types/pg`.
- devvit.json / word-data reference files: untouched.

**Key design invariant (gameplay):** the client treats `similarity === 1` as the winning
guess, and only the secret word gets exactly 1 (injected by `renderLetterCsv` in
`src/server/core/api.ts`). Definition-based similarity can produce exactly 1.0 for words
sharing an identical WordNet definition (synonyms!). Therefore the generator **must clamp
every non-target similarity to ≤ 0.9999** before encoding.

## REMAINING WORK (in order)

### 1. Fix outstanding type-check errors

`bun run type-check` currently fails. Issues found (last run):

- `src/client/vitest.config.ts(13)`: `launch` not in `BrowserInstanceOption` type
  (vitest 3.2.4's `BrowserProviderOptions` is an empty interface, but the runtime passes
  instance options through to `playwright[...].launch(...)` — verified in
  `node_modules/@vitest/browser/dist/webdriver-KA1WiV0q.js`). Fix: declare-module
  augmentation, e.g. in `src/client/module.d.ts`:
  `declare module 'vitest' { interface BrowserProviderOptions { launch?: Record<string, unknown>; } }`
  (verify which specifier merges; must type-check AND keep tests green).
- `tools/word-data/embed-definitions.ts`: unused `EmbeddingRow` type (TS6196) — remove.
- `tools/word-data/generate-missing-definitions.ts(13)`: unused `node:fs` import — remove.
- `tools/word-data/embed-definitions.ts(83)`: p-queue **v10** — `carryoverConcurrencyCount`
  no longer exists in `Options`; check `node_modules/p-queue/dist/index.d.ts` for the v10
  equivalent (or drop the option; `interval`/`intervalCap`/`concurrency` still work).
- `tools/word-data/common.ts`: TS6059/TS6307 — importing
  `../../src/server/core/wordDataFormat.ts` violates the tools project's `rootDir`/file list.
  Options: (a) remove `./tools` from root `tsconfig.json` references (tools then untyped,
  matching the old repo where `tools/` was never type-checked — pragmatic fallback), or
  (b) try tools tsconfig `rootDir: ".."` + explicitly `include` the needed src files.
  If (b) gets fragile, use (a).
- `src/server/core/challenge.tsx(122)`: `'splash' does not exist in type ...` —
  **PRE-EXISTING** from the user's uncommitted work (challenge.tsx was already modified
  before this session). Do NOT "fix" it; leave it for the user.

### 2. Write `tools/word-data/generate-word-data.ts` (step 4 — the final pipeline piece)

Design (mirrors the deleted generator, which is viewable at
`git show 0623eb4^:tools/generate-full-word-data.ts` — reuse its structure):

- Args: `--embeddings` (default `tools/word-data/out/definition-embeddings.csv`),
  `--dictionary` (default `word-data/v1/_dictionary.csv.gz`), `--targets` (optional file),
  `--output` (default `word-data/v1`), `--limit`, `--force`,
  `--keep-database-running`, `--rebuild-database`.
- Validate: every dictionary word has an embedding; uniform dimension (detect from first
  row; old data was 3072).
- **Targets default = existing `word-data/v1/*.bin.gz` filenames (2,351 words)** — this
  keeps every live challenge working; do not generate new targets by default.
- Docker: use existing `docker-compose.word-data.yml` (mounts `./word-data/v1` at
  `/data:ro`; creds: user `synonymity`, password `synonymity-local`, db `synonymity`,
  host 127.0.0.1, port `${WORD_DATA_DB_PORT:-55432}`). `docker compose up -d pgvector`,
  poll `pg_isready`.
- DB import: write a POSTGRES-COPY-friendly `_db-import.csv` (`word,embedding,is_hint`,
  embedding = quoted JSON array) **into `word-data/v1/`** (so the ro mount sees it),
  `CREATE EXTENSION vector;`, `words(word text pk, embedding vector(D), is_hint bool)`,
  `COPY ... FROM '/data/_db-import.csv' WITH (FORMAT csv, HEADER true)`.
- Per-target ranking (exact, no ANN — same SQL as the old generator):
  ```sql
  SELECT w.word, 1 - (w.embedding <=> target.embedding) AS similarity
  FROM words w
  CROSS JOIN (SELECT embedding FROM words WHERE word = $1) target
  WHERE w.word <> $1
  ORDER BY w.embedding <=> target.embedding, w.word
  ```
  Concurrency 4 (pg Pool + PQueue), progress logging.
- **Clamp similarity to `[-1, 0.9999]`** (see invariant above) before encoding.
- Encode with `encodeStaticWordConfig` from
  `../../src/server/core/wordDataFormat.ts` (`exactCount` 2500); filename
  `encodeURIComponent(word) + '.bin.gz'` (replace `'` with `%27`, matching
  `wordFileName` in `staticWordData.ts`).
- Also write per-target **reference CSVs, top 100 rows** (`word,similarity,rank,isHint`
  with header + rank-0 target row) — the old CSVs have 2,501 rows each (~176 MB of repo
  bloat); the new smaller ones shrink that. (Server never serves these; they're
  developer reference only.)
- Re-emit `_dictionary.csv.gz` (unchanged content via `encodeStaticDictionary`) and
  `_top25.csv.gz` (golden `target,rank,word,similarity` top-25 rows, same format as old).
- **Staging + atomic swap** (old generator's pattern): build the full new dir in
  `word-data/v1.tmp-<pid>` (copy over the non-target reference files: `word-list.csv`,
  `hints.csv`, `lemma.csv`), `rm -rf` the output dir, rename staging into place.
- Clean up `_db-import.csv` + any copied `definition-embeddings.csv` from `word-data/v1`
  after the run (both are git-ignored patterns already).
- **Smoke-test without an API key:** add a `--fake-embeddings` flag that derives
  deterministic pseudo-vectors (e.g. hash-seeded) from the definition text — lets you
  verify the whole docker/pgvector/encode/decode mechanics end-to-end (`--limit 5`),
  then decode a produced file with the real decoder and render a letter CSV via
  `renderLetterCsv` to confirm the serving path works.

### 3. package.json scripts

Add (bun style, `node --experimental-strip-types` is NOT needed under bun — bun runs
`.ts` natively; the old `#!/usr/bin/env node --experimental-strip-types` shebangs are
harmless):

```json
"word-data:definitions": "bun tools/word-data/build-definitions.ts",
"word-data:gemini-definitions": "bun tools/word-data/generate-missing-definitions.ts",
"word-data:embeddings": "bun tools/word-data/embed-definitions.ts",
"word-data:generate": "bun tools/word-data/generate-word-data.ts",
"word-data:rebuild": "bun run word-data:definitions && bun run word-data:gemini-definitions && bun run word-data:embeddings && bun run word-data:generate"
```

(Verify each runs under bun; the cross-project `.ts`-extension imports must work — bun
handles them fine.)

### 4. Bump the word-data release

`src/shared/wordDataVersion.ts`: `WORD_DATA_RELEASE = 'v1-full-64639-r2'` →
`'v1-full-64639-def-1'`. This invalidates: client IndexedDB cache (URL changes), server
Redis cache keys (`word_config4:${RELEASE}:...`), and the GitHub-raw `?release=` cache
buster. Safe to bump before/without regenerating (same files served); do it when the
regenerated data lands in the same commit.

### 5. Docs

- `tools/word-data/README.md`: the new algorithm (why definitions, what gets embedded),
  the 4-step runbook with the `export GOOGLE_API_KEY=*** cost/rate notes
  (embeddings = 64,639 texts / 100 per request ≈ 647 calls; pgvector ranking of
  2,351 targets × 64,639 × 3072-d exact cosine is the long pole — tens of minutes on a
  laptop), the 0.9999 clamp invariant, and the target-set default.
- `README.md`: one or two lines replacing the implicit old behavior ("closeness is
  measured by how similar the dictionary definitions are").

### 6. Verification checklist

1. `bun run type-check` — green (except the pre-existing `challenge.tsx` splash error,
   which the user owns).
2. `bun run test` — all green (expect 200+ tests incl. `tools/` project).
3. `bun run lint`, `bun run build` — green.
4. `--fake-embeddings --limit 5` docker smoke test: produced `.bin.gz` decodes with
   `decodeStaticWordConfig`, letter CSV render works, closest ≠ target, no similarity = 1
   except the injected secret.
5. (User, with API key) real run: `bun run word-data:rebuild`; then sanity-check rankings:
   in the new `fork` data, `pitchfork` should rank well within the top few hundred and
   `fortnight` near the bottom; `couch`/`sofa` mutually at the very top (0.9999).
6. Commit regenerated `word-data/v1/*` + the `WORD_DATA_RELEASE` bump together. The live
   server fetches from
   `https://raw.githubusercontent.com/bck01215/synonymity/main/word-data/v1` — the
   data must be pushed to that repo's `main` to take effect (out of scope for this repo).

## Gotchas / context

- **~15 files have the user's pre-existing uncommitted changes** (README.md, devvit.json,
  docker-compose.word-data.yml, `src/client/classic/*`, `src/server/core/challenge.tsx`,
  `wtfResponder.ts`, …). Don't touch or commit them. `git status` will show them alongside
  this session's changes.
- This session's changes: `.nvmrc`, `AGENTS.md`, `package.json`, `.gitignore`,
  `tsconfig.json`, `vitest.config.ts`, `bun.lock` (new), `package-lock.json` (deleted),
  `src/server/vitest-redis-setup.ts` (new), `src/server/vitest.config.ts`,
  `src/client/vitest.config.ts`, `src/server/core/wordDataFormat.ts` (new),
  `src/server/core/wordDataFormat.test.ts` (new), `src/server/core/staticWordData.ts`,
  `tools/**` (new: english-wordnet-2024.xml is git-ignored; word-data/*.ts, tsconfig, vitest).
- The serving path (unchanged): server decodes the secret's `.bin.gz`
  (`staticWordData.ts` → GitHub raw) → `api.ts` `renderLetterCsv`/`buildHintCsvForChallenge`
  → client `src/client/core/guess.ts` fetches per-letter CSVs and reads
  `similarity`/`rank`. Win = `similarity === 1`.
- `word-data/v1/` also contains `word-list.csv`, `hints.csv`, `lemma.csv` (reference
  files; hints.csv exactly matches the dictionary's `isHint` set).
- WordNet definition quirk: some lemmas are multi-word (`a cappella`) or contain entities
  (`&apos;`); the dictionary only contains single-token words, so exact lowercase
  `writtenForm` match is correct.
- Node type-stripping (and bun) require **explicit `.ts` extensions** on relative local
  imports in `tools/` (e.g. `from './common.ts'`). `tools/tsconfig.json` has
  `rewriteRelativeImportExtensions: true` to keep tsc happy if the tools project is kept
  in the build.
- The old generator's "baseline compatibility gate" (top-25 must match old data) is
  deliberately gone — the whole point is that rankings change.
