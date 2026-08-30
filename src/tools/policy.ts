import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RamcpConfig } from '../core/config.js';
import { resolveReal, PolicyConfig } from '../core/policy.js';

export function registerPolicyTools(server: McpServer, cfg: RamcpConfig, reload: () => void): void {
  const persist = () => {
    const { saveConfig } = require('../core/config.js') as typeof import('../core/config.js');
    saveConfig(cfg);
    reload();
  };

  // ---- list_allowed_paths ----------------------------------------------------------
  server.registerTool('list_allowed_paths',
    {
      description: 'Show which paths the AI may access and whether shell is enabled.',
      inputSchema: {},
    },
    async () => {
      const out = [
        `allowed: ${cfg.allowed_paths.length ? cfg.allowed_paths.join(', ') : '(none)'}`,
        `denied: ${cfg.denied_paths.length ? cfg.denied_paths.join(', ') : '(none)'}`,
        `shell: ${cfg.shell_enabled ? 'enabled' : 'disabled'}`,
      ].join('\n');
      return { content: [{ type: 'text', text: out }] };
    });

  // ---- allow_path ----------------------------------------------------------------------
  server.registerTool('allow_path',
    {
      description: 'Grant the AI access to a directory path.',
      inputSchema: { path: z.string().describe('Absolute path to allow') },
    },
    async ({ path }) => {
      const real = resolveReal(path);
      if (!cfg.allowed_paths.includes(real)) cfg.allowed_paths.push(real);
      persist();
      return { content: [{ type: 'text', text: `Allowed: ${real}` }] };
    });

  // ---- deny_path -------------------------------------------------------------------------
  server.registerTool('deny_path',
    {
      description: 'Revoke access to a directory path and/or explicitly deny it.',
      inputSchema: { path: z.string().describe('Absolute path to deny') },
    },
    async ({ path }) => {
      const real = resolveReal(path);
      cfg.allowed_paths = cfg.allowed_paths.filter(p => p !== real);
      if (!cfg.denied_paths.includes(real)) cfg.denied_paths.push(real);
      persist();
      return { content: [{ type: 'text', text: `Denied: ${real}` }] };
    });

  // ---- shell_enabled ----------------------------------------------------------------------
  server.registerTool('shell_enabled',
    {
      description: 'Check whether shell command execution is currently allowed.',
      inputSchema: {},
    },
    async () => {
      return { content: [{ type: 'text', text: cfg.shell_enabled ? 'enabled' : 'disabled' }] };
    });
}
