import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { assertToolPermitted } from '../core/policy.js';
import type { ToolContext } from '../core/context.js';

const exec = promisify(execFile);

// Git args are validated: allow only known verbs + safe option characters.
// This blocks option-injection like `--upload-pack` or hook smuggling
// through crafted "subcommand" strings.
const GIT_VERBS = /^(add|bisect|branch|checkout|clone|commit|describe|diff|fetch|grep|init|log|merge|mv|pull|push|rebase|remote|reset|revert|rm|show|stash|status|tag|fetch|format-patch|apply|blame|shortlog|cherry-pick|switch|restore|worktree|config|ls-files|ls-remote|rev-parse|clean|archive|gc)$/;

function validateGitArgs(args: string[]): string | null {
  if (!args.length) return 'empty git args';
  const verb = args[0];
  if (!GIT_VERBS.test(verb)) return `git verb "${verb}" not allowed`;
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    // Refuse option injection & shell metacharacters in args
    if (a.startsWith('--upload-pack') || a.startsWith('--exec=')) return `option ${a} not allowed`;
    if (/[;&|`$><]/.test(a)) return `metacharacter in "${a}"`;
  }
  return null;
}

export function registerGitTools(server: McpServer, ctx: ToolContext): void {
  const policy = () => ({
    allowed_paths: ctx.token.allowed_paths,
    denied_paths: ctx.token.denied_paths,
    shell_enabled: ctx.token.shell_enabled,
  });

  // ---- git ------------------------------------------------------------------------
  server.registerTool('git',
    {
      description: 'Run git commands in a repository (verbs whitelisted, options validated). Policy-checked.',
      inputSchema: {
        repo_path: z.string().describe('Path to the git repository'),
        args: z.array(z.string()).describe('Arguments to git, e.g. ["status", "--short"]'),
      },
    },
    async ({ repo_path, args }) => {
      assertToolPermitted({ tool: 'git', scopes: ctx.token.scopes, readOnly: ctx.readOnly, policy: policy(), target: repo_path });
      const err = validateGitArgs(args);
      if (err) {
        return { content: [{ type: 'text', text: `git args rejected: ${err}` }], isError: true };
      }
      try {
        const { stdout, stderr } = await exec('git', args, {
          cwd: repo_path,
          timeout: 60_000,
          maxBuffer: 10 * 1024 * 1024,
        });
        let out = stdout;
        if (stderr) out += (out ? '\n' : '') + stderr;
        return { content: [{ type: 'text', text: out || '(no output)' }] };
      } catch (e: any) {
        const msg = [e.message, e.stdout, e.stderr].filter(Boolean).join('\n');
        return { content: [{ type: 'text', text: msg || e.message }], isError: true };
      }
    });
}
