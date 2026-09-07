import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../core/context.js';
import { assertToolPermitted } from '../core/policy.js';
import { TaskEngine, taskSummary, type TaskAction } from '../core/task-engine.js';
import type { AutonomyLevel } from '../core/agent-contracts.js';

export function registerTaskTools(server: McpServer, ctx: ToolContext): void {
  const permitted = (tool: string) => assertToolPermitted({ tool, scopes: ctx.token.scopes, readOnly: ctx.readOnly });
  const engine = new TaskEngine(ctx.token.token, async (name, args) => {
    if (!ctx.invokeTool) throw new Error('task executor is unavailable');
    return ctx.invokeTool(name, args);
  });

  server.registerTool('task', {
    description: 'Create and optionally execute an intent-driven task. Actions form a validated dependency graph; use dry_run to inspect without executing.',
    inputSchema: {
      goal: z.string().min(1).max(4000),
      actions: z.array(z.object({
        id: z.string().min(1).max(64),
        agent: z.enum(['explorer','planner','implementer','tester','reviewer','security','deployer']).optional(),
        tool: z.string().min(1),
        arguments: z.record(z.unknown()).optional(),
        depends_on: z.array(z.string()).optional(),
        condition: z.enum(['always', 'on_success', 'on_failure']).optional(),
        timeout_ms: z.number().int().min(100).max(600000).optional(),
        retries: z.number().int().min(0).max(5).optional(),
        rollback: z.object({ tool: z.string().min(1), arguments: z.record(z.unknown()).optional() }).optional(),
        verify: z.object({ tool: z.string().min(1), arguments: z.record(z.unknown()).optional() }).optional(),
      })).min(1).max(64),
      autonomy: z.enum(['readonly', 'safe', 'supervised', 'autonomous']).default('safe'),
      dry_run: z.boolean().default(false),
      execute: z.boolean().default(true),
    },
  }, async ({ goal, actions, autonomy, dry_run, execute }) => {
    permitted('task');
    const row = engine.create({ goal, actions: actions.map(a => ({ id: a.id, agent: a.agent, tool: a.tool, arguments: a.arguments, dependsOn: a.depends_on, condition: a.condition, timeoutMs: a.timeout_ms, retries: a.retries, rollback: a.rollback, verify: a.verify })) as TaskAction[], autonomy: autonomy as AutonomyLevel, dryRun: dry_run });
    if (!execute || dry_run) return { content: [{ type: 'text', text: JSON.stringify(taskSummary(row)) }] };
    const result = await engine.run(row.id);
    return { content: [{ type: 'text', text: JSON.stringify(taskSummary(result)) }], isError: result.state === 'failed' };
  });

  server.registerTool('task_list', {
    description: 'List recent durable tasks belonging to the current token.',
    inputSchema: { limit: z.number().int().min(1).max(100).default(20) },
  }, async ({ limit }) => {
    permitted('task_list');
    return { content: [{ type: 'text', text: JSON.stringify(engine.list(limit)) }] };
  });

  server.registerTool('task_approve', {
    description: 'Approve a supervised task and resume its execution. Approval is scoped to the current token.',
    inputSchema: { id: z.string() },
  }, async ({ id }) => {
    permitted('task_approve');
    const result = await engine.approve(id);
    return { content: [{ type: 'text', text: JSON.stringify(taskSummary(result)) }], isError: result.state === 'failed' };
  });

  server.registerTool('task_reject', {
    description: 'Reject a supervised task that is waiting for approval. The task is durably cancelled.',
    inputSchema: { id: z.string() },
  }, async ({ id }) => {
    permitted('task_reject');
    const result = engine.reject(id);
    return { content: [{ type: 'text', text: JSON.stringify(taskSummary(result)) }] };
  });

  server.registerTool('task_resume', {
    description: 'Resume a queued, interrupted, or failed task from its durable action state.',
    inputSchema: { id: z.string() },
  }, async ({ id }) => {
    permitted('task_resume');
    const result = await engine.resume(id);
    return { content: [{ type: 'text', text: JSON.stringify(taskSummary(result)) }], isError: result.state === 'failed' };
  });
}
