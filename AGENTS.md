# Repository guidance

## Project layout

- `src/client` contains the Preact webviews. Use browser-compatible dependencies and prefer Preact signals for shared reactive state.
- `src/server` contains the Devvit serverless backend. Use `fetch` for network calls and `redis` from `@devvit/web/server` for persistence; do not rely on writable local files, sockets, or long-lived in-memory state.
- `src/shared` contains code and types shared by the client and server.
- Keep classic-mode changes under the existing classic paths and horde-mode changes isolated to horde-specific paths.

## Development

- Use **bun** (not npm) for all package management and script execution: `bun install`, `bun run <script>`, `bun run test`. The lockfile is `bun.lock`; do not reintroduce `package-lock.json`.
- Use TypeScript, named exports, and type aliases where practical.
- Follow the existing formatting and lint rules; avoid unrelated generated word-data changes.
- Use the repository's `devvit-docs` skill for current Devvit API, configuration, and platform questions.
- Server tests boot a real redis via `redis-memory-server`. A local `redis-server` (or `valkey`, e.g. `brew install redis`) on the PATH is required; `src/server/vitest-redis-setup.ts` auto-detects it. Set `REDISMS_SYSTEM_BINARY` to override.
- Browser-mode tests (client) run against the system **Google Chrome** (`channel: 'chrome'` in `src/client/vitest.config.ts`); no Playwright browser download is needed.

## Checks

- `bun run type-check`
- `bun run test` (vitest; or `bun run test <test-file>` for a focused run). Bare `bun test` invokes bun's own runner, which cannot run these suites.
- `bun run lint`
- `bun run build`
