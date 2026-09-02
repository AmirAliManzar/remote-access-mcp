import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../core/context.js';
import { assertToolPermitted, assertAllowed, assertCommandPolicy } from '../core/policy.js';
import { jobManager } from '../core/jobs.js';
import { AuditLog } from '../core/audit.js';

export function registerJobTools(server: McpServer, ctx: ToolContext): void {
  const policy = () => ({ allowed_paths: ctx.token.allowed_paths, denied_paths: ctx.token.denied_paths, shell_enabled: ctx.token.shell_enabled });
  const tid = AuditLog.fingerprint(ctx.token.token);
  server.registerTool('run_background', { description: 'Run a shell command asynchronously in the local worker pool. Returns a job id.', inputSchema: { command: z.string(), cwd: z.string().optional(), timeout_ms: z.number().min(1000).max(600000).default(600000), max_attempts: z.number().int().min(1).max(5).default(1) } }, async ({ command, cwd, timeout_ms, max_attempts }) => {
    if (!ctx.token.shell_enabled) return { content: [{ type: 'text', text: 'Shell execution is disabled for this token.' }], isError: true };
    assertToolPermitted({ tool: 'run_background', scopes: ctx.token.scopes, readOnly: ctx.readOnly, policy: policy(), target: cwd });
    assertCommandPolicy({ command_allowlist: ctx.token.command_allowlist, approval_mode: 'auto' }, command, true);
    const j = jobManager.create(command, tid, cwd, timeout_ms, max_attempts); return { content: [{ type: 'text', text: JSON.stringify({ id: j.id, status: j.status, workers: 'shared worker pool' }) }] };
  });
  server.registerTool('job_status', { description: 'Get status and recent output of a background job.', inputSchema: { id: z.string() } }, async ({ id }) => {
    assertToolPermitted({ tool: 'job_status', scopes: ctx.token.scopes, readOnly: ctx.readOnly }); const j = jobManager.get(id, tid);
    if (!j) return { content: [{ type: 'text', text: 'Job not found.' }], isError: true }; return { content: [{ type: 'text', text: JSON.stringify(j, null, 2) }] };
  });
  server.registerTool('job_output', { description: 'Read accumulated stdout/stderr from a background job.', inputSchema: { id: z.string() } }, async ({ id }) => {
    assertToolPermitted({ tool: 'job_output', scopes: ctx.token.scopes, readOnly: ctx.readOnly }); const j = jobManager.get(id, tid); if (!j) return { content: [{ type: 'text', text: 'Job not found.' }], isError: true }; return { content: [{ type: 'text', text: j.output }] };
  });
  server.registerTool('job_list', { description: 'List background jobs belonging to the current token.', inputSchema: {} }, async () => { assertToolPermitted({ tool: 'job_list', scopes: ctx.token.scopes, readOnly: ctx.readOnly }); return { content: [{ type: 'text', text: JSON.stringify(jobManager.list(tid), null, 2) }] }; });
  server.registerTool('job_cancel', { description: 'Cancel a queued or running background job.', inputSchema: { id: z.string() } }, async ({ id }) => { assertToolPermitted({ tool: 'job_cancel', scopes: ctx.token.scopes, readOnly: ctx.readOnly }); const ok = jobManager.cancel(id, tid); return { content: [{ type: 'text', text: ok ? `Job ${id} cancellation requested.` : 'Job not found or not cancellable.' }], isError: !ok }; });
  server.registerTool('run_parallel', { description: 'Queue multiple shell commands for parallel execution by the shared worker pool. Concurrency is bounded globally.', inputSchema: { commands: z.array(z.string()).min(1).max(32), cwd: z.string().optional() } }, async ({ commands, cwd }) => {
    if (!ctx.token.shell_enabled) return { content: [{ type: 'text', text: 'Shell execution is disabled for this token.' }], isError: true };
    assertToolPermitted({ tool: 'run_parallel', scopes: ctx.token.scopes, readOnly: ctx.readOnly, policy: policy(), target: cwd });
    for (const command of commands) assertCommandPolicy({ command_allowlist: ctx.token.command_allowlist, approval_mode: 'auto' }, command, true);
    const jobs = commands.map(command => jobManager.create(command, tid, cwd)); return { content: [{ type: 'text', text: JSON.stringify(jobs.map(j => ({ id: j.id, command: j.command, status: j.status })), null, 2) }] };
  });
}
