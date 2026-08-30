import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { saveConfig, type RamcpConfig } from '../core/config.js';
import { resolveReal } from '../core/policy.js';
import { assertToolPermitted } from '../core/policy.js';
import type { ToolContext } from '../core/context.js';

/**
 * In-chat policy management. Mutations are limited to the CALLING token:
 * a token can widen or narrow its own sandbox but never touch other
 * tokens' policies — that stays a CLI-only operation (root).
 */
export function registerPolicyTools(server: McpServer, ctx: ToolContext): void {
  const persist = () => saveConfig(ctx.cfg);

  // ---- list_allowed_paths ----------------------------------------------------------
  server.registerTool('list_allowed_paths',
    {
      description: 'Show this token\'s path policy and shell flag.',
      inputSchema: {},
    },
    async () => {
      assertToolPermitted({ tool: 'list_allowed_paths', scopes: ctx.token.scopes, readOnly: ctx.readOnly });
      const t = ctx.token;
      const out = [
        `token: ${t.name}`,
        `allowed: ${t.allowed_paths.length ? '\n  ' + t.allowed_paths.join('\n  ') : '(none)'}`,
        `denied: ${t.denied_paths.length ? '\n  ' + t.denied_paths.join('\n  ') : '(none)'}`,
        `shell: ${t.shell_enabled ? 'enabled' : 'disabled'}`,
        `read_only: ${t.read_only ? 'yes' : 'no'}`,
        `scopes: ${t.scopes.length ? t.scopes.join(', ') : '(all tools)'}`,
      ].join('\n');
      return { content: [{ type: 'text', text: out }] };
    });

  // ---- allow_path ----------------------------------------------------------------------
  server.registerTool('allow_path',
    {
      description: 'Grant this token access to a directory path.',
      inputSchema: { path: z.string().describe('Absolute path to allow') },
    },
    async ({ path }) => {
      assertToolPermitted({ tool: 'allow_path', scopes: ctx.token.scopes, readOnly: ctx.readOnly });
      const real = resolveReal(path);
      if (!ctx.token.allowed_paths.includes(real)) ctx.token.allowed_paths.push(real);
      persist();
      return { content: [{ type: 'text', text: `Allowed: ${real}` }] };
    });

  // ---- deny_path -------------------------------------------------------------------------
  server.registerTool('deny_path',
    {
      description: 'Revoke this token\'s access to a directory path.',
      inputSchema: { path: z.string().describe('Absolute path to deny') },
    },
    async ({ path }) => {
      assertToolPermitted({ tool: 'deny_path', scopes: ctx.token.scopes, readOnly: ctx.readOnly });
      const real = resolveReal(path);
      ctx.token.allowed_paths = ctx.token.allowed_paths.filter((p: string) => p !== real);
      if (!ctx.token.denied_paths.includes(real)) ctx.token.denied_paths.push(real);
      persist();
      return { content: [{ type: 'text', text: `Denied: ${real}` }] };
    });

  // ---- shell_enabled ----------------------------------------------------------------------
  server.registerTool('shell_enabled',
    {
      description: 'Check whether shell command execution is allowed for this token.',
      inputSchema: {},
    },
    async () => {
      assertToolPermitted({ tool: 'shell_enabled', scopes: ctx.token.scopes, readOnly: ctx.readOnly });
      return { content: [{ type: 'text', text: ctx.token.shell_enabled ? 'enabled' : 'disabled' }] };
    });
}
