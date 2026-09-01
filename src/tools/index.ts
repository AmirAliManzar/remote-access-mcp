import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../core/context.js';
import { registerSystemTools } from './system.js';
import { registerFilesystemTools } from './filesystem.js';
import { registerShellTools } from './shell.js';
import { registerHttpTools } from './http.js';
import { registerGitTools } from './git.js';
import { registerSqliteTools } from './sqlite.js';
import { registerPolicyTools } from './policy.js';
import { registerLogTools } from './logs.js';
import { registerServiceTools } from './services.js';
import { registerPackageTools } from './packages.js';
import { registerScheduleTools } from './schedule.js';
import { registerSecurityTools } from './security.js';
import { registerProjectTools } from './project.js';
import { registerWebTools } from './web.js';
import { registerPlanningTools } from './planning.js';
import { registerOpsTools } from './ops.js';
import { registerFleetTools } from './fleet.js';
import { registerIntegrationTools } from './integrations.js';

/**
 * Register every tool suite for this request's token context.
 * Fresh registration per request → policy mutations apply instantly.
 */
export async function registerAllTools(server: McpServer, ctx: ToolContext): Promise<void> {
  registerSystemTools(server, ctx);
  registerFilesystemTools(server, ctx);
  registerShellTools(server, ctx);
  registerHttpTools(server, ctx);
  registerGitTools(server, ctx);
  registerSqliteTools(server, ctx);
  registerPolicyTools(server, ctx);
  registerLogTools(server, ctx);
  registerServiceTools(server, ctx);
  registerPackageTools(server, ctx);
  registerScheduleTools(server, ctx);
  registerSecurityTools(server, ctx);
  registerProjectTools(server, ctx);
  registerWebTools(server, ctx);
  registerPlanningTools(server, ctx);
  registerOpsTools(server, ctx);
  registerFleetTools(server, ctx);

  // Integration subprocesses are disabled in the unit-test environment so
  // core transport/auth tests stay deterministic. Production loads them
  // before the MCP transport connects, so the initial tools/list is complete.
  if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
    await registerIntegrationTools(server, ctx);
  }
}
