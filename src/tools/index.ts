import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RamcpConfig } from '../core/config.js';
import type { PolicyConfig } from '../core/policy.js';
import { registerFilesystemTools } from './filesystem.js';
import { registerShellTools } from './shell.js';
import { registerSystemTools } from './system.js';
import { registerHttpTools } from './http.js';
import { registerGitTools } from './git.js';
import { registerSqliteTools } from './sqlite.js';
import { registerPolicyTools } from './policy.js';

export function registerAllTools(server: McpServer, cfg: RamcpConfig, policy: PolicyConfig, reload: () => void): void {
  registerSystemTools(server);
  registerFilesystemTools(server, policy);
  registerShellTools(server, policy);
  registerHttpTools(server);
  registerGitTools(server, policy);
  registerSqliteTools(server, policy);
  registerPolicyTools(server, cfg, reload);
}
