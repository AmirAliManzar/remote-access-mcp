import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PolicyConfig, assertAllowed } from '../core/policy.js';

const exec = promisify(execFile);

export function registerGitTools(server: McpServer, policy: PolicyConfig): void {
  // ---- git ------------------------------------------------------------------------
  server.registerTool('git',
    {
      description: 'Run git commands in a repository. Policy-checked.',
      inputSchema: {
        repo_path: z.string().describe('Path to the git repository'),
        args: z.array(z.string()).describe('Arguments to git, e.g. ["status", "--short"]'),
      },
    },
    async ({ repo_path, args }) => {
      assertAllowed(policy, repo_path);
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
