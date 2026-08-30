import fs from 'node:fs';
import type { RamcpConfig, TokenRecord } from './config.js';

/**
 * Hot-reload: re-reads config.json on every request when its mtime changed.
 * Policy edits via CLI or via tools take effect within one request —
 * no restart needed.
 */
export class ConfigWatcher {
  private mtimeMs = 0;
  private path: string;

  constructor(path: string) {
    this.path = path;
    this.mtimeMs = this.stat();
  }

  private stat(): number {
    try {
      return fs.statSync(this.path).mtimeMs;
    } catch {
      return 0;
    }
  }

  /** Returns true when the underlying file changed since the last check. */
  changed(): boolean {
    const m = this.stat();
    if (m !== this.mtimeMs) {
      this.mtimeMs = m;
      return true;
    }
    return false;
  }
}

/** Per-request execution context passed into tool registration. */
export interface ToolContext {
  cfg: RamcpConfig;
  token: TokenRecord;
  readOnly: boolean;
  persist: () => void;   // save config after mutations
  audit: (tool: string, args: Record<string, unknown>, ok: boolean, isError: boolean, durationMs: number) => void;
}
