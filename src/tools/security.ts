import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { assertToolPermitted } from '../core/policy.js';
import type { ToolContext } from '../core/context.js';

const exec = promisify(execFile);

// Patterns that indicate a leaked credential. Deliberately broad —
// better a false positive the human reviews than a missed live key.
const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/],
  ['aws access key', /AKIA[0-9A-Z]{16}/],
  ['github token (classic)', /gh[pousr]_[A-Za-z0-9]{20,}/],
  ['github fine-grained token', /github_pat_[A-Za-z0-9_]{20,}/],
  ['slack token', /xox[baprs]-[A-Za-z0-9-]{10,}/],
  ['telegram bot token', /\d{8,10}:AA[A-Za-z0-9_-]{30,}/],
  ['npm token', /npm_[A-Za-z0-9]{30,}/],
  ['google api key', /AIza[0-9A-Za-z_-]{35}/],
  ['generic bearer (long)', /bearer\s+[A-Za-z0-9._-]{40,}/i],
  ['password in connection string', /[a-z+]+:\/\/[^:\s]+:[^@\s]{8,}@/i],
];

const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', '.next', 'coverage']);
const TEXT_EXT = /\.(txt|json|ya?ml|toml|ini|env|conf|cfg|js|jsx|ts|tsx|py|rb|go|rs|java|php|sh|bash|sql|md|html|css|xml)$/i;

export function registerSecurityTools(server: McpServer, ctx: ToolContext): void {
  // ---- secret_scan -----------------------------------------------------------
  server.registerTool('secret_scan',
    {
      description: 'Scan a directory tree for leaked secrets (private keys, API tokens, passwords). Policy-checked.',
      inputSchema: {
        path: z.string().describe('Directory to scan'),
        max_files: z.number().optional().default(2000).describe('File cap'),
      },
    },
    async ({ path: dir, max_files }) => {
      assertToolPermitted({
        tool: 'secret_scan', scopes: ctx.token.scopes, readOnly: ctx.readOnly,
        policy: { allowed_paths: ctx.token.allowed_paths, denied_paths: ctx.token.denied_paths, shell_enabled: ctx.token.shell_enabled },
        target: dir,
      });
      const findings: string[] = [];
      let scanned = 0;
      const walk = async (d: string): Promise<void> => {
        if (scanned >= max_files || findings.length >= 200) return;
        let entries: fs.Dirent[];
        try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (scanned >= max_files) return;
          if (e.name.startsWith('.') && e.name !== '.env') continue;
          const full = path.join(d, e.name);
          if (e.isDirectory()) {
            if (!SKIP_DIRS.has(e.name)) await walk(full);
          } else if (e.isFile() && TEXT_EXT.test(e.name)) {
            scanned++;
            let content: string;
            try { content = await fsp.readFile(full, 'utf8'); } catch { continue; }
            const lines = content.split('\n');
            for (let i = 0; i < lines.length; i++) {
              for (const [label, re] of SECRET_PATTERNS) {
                if (re.test(lines[i])) {
                  // Mask the actual secret — we only report where it is
                  findings.push(`${full}:${i + 1} — possible ${label}`);
                  break;
                }
              }
            }
          }
        }
      };
      await walk(dir);
      const summary = findings.length
        ? `Found ${findings.length} potential secret(s) in ${scanned} files:\n${findings.join('\n')}`
        : `Clean: no secrets found in ${scanned} files.`;
      return { content: [{ type: 'text', text: summary }] };
    });

  // ---- port_scan_local ----------------------------------------------------------
  server.registerTool('port_scan_local',
    {
      description: 'List all listening TCP ports on this host with the owning process (ss -tlnp).',
      inputSchema: {},
    },
    async () => {
      assertToolPermitted({ tool: 'port_scan_local', scopes: ctx.token.scopes, readOnly: ctx.readOnly });
      try {
        const { stdout } = await exec('ss', ['-tlnp']);
        return { content: [{ type: 'text', text: stdout }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: e.message }], isError: true };
      }
    });
}
