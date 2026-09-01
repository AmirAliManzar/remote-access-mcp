/**
 * Hermetic test bootstrap (ADR-006).
 *
 * `CONFIG_DIR` in src/core/config.ts is computed at module import from the
 * real HOME. Tests that build gateway state manually still trigger
 * `loadConfig()` inside `createGatewayState()`, which — on a machine with no
 * config yet — writes a fresh random-token config to the SHARED real HOME.
 * Parallel vitest workers then see each other's writes through the
 * ConfigWatcher (`gw.reload()` on every request) and the in-test token gets
 * clobbered by a random one → 401s, flaky CI.
 *
 * Fix: point HOME at an isolated temp dir before any src module is imported.
 * Per-file temp homes (ramcp-clihome-*) still work — tests that set their own
 * HOME in a child-process env are unaffected.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TEST_HOME = path.join(os.tmpdir(), `ramcp-vitest-home-${process.pid}`);
fs.mkdirSync(TEST_HOME, { recursive: true });
process.env.HOME = TEST_HOME;
// GitHub runners preset XDG_CONFIG_HOME=/home/runner/.config — dataDir()
// prefers it over HOME, which would re-share one config path across all
// parallel workers. Unset it so Linux falls back to $HOME/.config.
delete process.env.XDG_CONFIG_HOME;
