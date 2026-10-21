import { execFileSync } from 'node:child_process';

/**
 * Devvit's test harness (`createDevvitTest`) boots a real redis via
 * `redis-memory-server`. Without a cached binary that package downloads
 * redis *source* and compiles it with `make`, which fails on stock macOS
 * (GNU Make 3.81 is too old).
 *
 * Point `redis-memory-server` at a local `redis-server` when one is
 * available on the PATH (e.g. `brew install redis` or valkey). An
 * explicit `REDISMS_SYSTEM_BINARY` always wins.
 */
if (!process.env.REDISMS_SYSTEM_BINARY) {
  try {
    const bin = execFileSync('sh', ['-c', 'command -v redis-server'], {
      encoding: 'utf8',
    }).trim();
    if (bin) process.env.REDISMS_SYSTEM_BINARY = bin;
  } catch {
    // No system redis; fall back to redis-memory-server's own resolution.
  }
}
