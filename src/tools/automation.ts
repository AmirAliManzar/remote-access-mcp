import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../core/context.js';
import { assertToolPermitted, assertAllowed } from '../core/policy.js';
import { AuditLog } from '../core/audit.js';
import { createRule, deleteRule, setRuleEnabled, tokenRules, type AutomationCondition, type TriggerType } from '../core/automation-engine.js';

const fp = (ctx: ToolContext) => AuditLog.fingerprint(ctx.token.token);
const condition = z.object({ field: z.string().min(1).max(64), op: z.enum(['equals','not_equals','contains','gt','gte','lt','lte']), value: z.union([z.string(), z.number(), z.boolean()]) });
const action = z.object({ tool: z.string().min(1).max(100), args: z.record(z.unknown()).default({}) });
const FORBIDDEN_ACTIONS = new Set(['automation_create','automation_list','automation_enable','automation_delete','automation_trigger','automation_status','approval_decide','plugin_install','plugin_remove']);

export function registerAutomationTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool('automation_create', { description: 'Create a persistent token-isolated automation rule. Trigger can be interval, tool, webhook, file, or health; actions execute through the normal policy gate.', inputSchema: {
    name: z.string().min(1).max(100), enabled: z.boolean().default(true),
    trigger: z.object({ type: z.enum(['interval','file','health','webhook','tool']), interval_seconds: z.number().int().min(60).optional(), path: z.string().optional(), event: z.string().optional(), tool: z.string().optional() }),
    conditions: z.array(condition).max(16).default([]), actions: z.array(action).min(1).max(8),
  } }, async ({ name, enabled, trigger, conditions, actions }) => {
    assertToolPermitted({ tool: 'automation_create', scopes: ctx.token.scopes, readOnly: ctx.readOnly });
    if (ctx.readOnly) return { content: [{ type: 'text', text: 'Read-only mode: automation creation refused.' }], isError: true };
    if (actions.some(a => FORBIDDEN_ACTIONS.has(a.tool))) return { content: [{ type: 'text', text: 'Automation cannot invoke control-plane or approval tools.' }], isError: true };
    try {
      for (const a of actions) {
        if (JSON.stringify(a.args).length > 64 * 1024) throw new Error(`Automation action args for ${a.tool} exceed 64 KiB.`);
        assertToolPermitted({ tool: a.tool, scopes: ctx.token.scopes, readOnly: ctx.readOnly });
      }
      if (trigger.type === 'file' && trigger.path) assertAllowed({ allowed_paths: ctx.token.allowed_paths, denied_paths: ctx.token.denied_paths, shell_enabled: ctx.token.shell_enabled, read_only: ctx.readOnly }, trigger.path);
    }
    catch (e: any) { return { content: [{ type: 'text', text: e?.message || 'Automation action is outside the token scope.' }], isError: true }; }
    if (trigger.type === 'interval' && !trigger.interval_seconds) return { content: [{ type: 'text', text: 'interval_seconds is required for interval triggers.' }], isError: true };
    const r = createRule({ name, enabled, tokenFingerprint: fp(ctx), trigger: { type: trigger.type as TriggerType, intervalSeconds: trigger.interval_seconds, path: trigger.path, event: trigger.event, tool: trigger.tool }, conditions: conditions as AutomationCondition[], actions, nextRun: trigger.type === 'interval' && trigger.interval_seconds ? new Date(Date.now() + trigger.interval_seconds * 1000).toISOString() : undefined });
    return { content: [{ type: 'text', text: JSON.stringify({ id: r.id, name: r.name, enabled: r.enabled, trigger: r.trigger }) }] };
  });

  server.registerTool('automation_list', { description: 'List automations belonging only to the current token.', inputSchema: {} }, async () => {
    assertToolPermitted({ tool: 'automation_list', scopes: ctx.token.scopes, readOnly: ctx.readOnly });
    return { content: [{ type: 'text', text: JSON.stringify(tokenRules(fp(ctx)).map(({ tokenFingerprint: _tokenFingerprint, ...r }) => r), null, 2) }] };
  });

  server.registerTool('automation_status', { description: 'Show status and run counters for one owned automation.', inputSchema: { id: z.string().uuid() } }, async ({ id }) => {
    assertToolPermitted({ tool: 'automation_status', scopes: ctx.token.scopes, readOnly: ctx.readOnly });
    const rule = tokenRules(fp(ctx)).find(r => r.id === id);
    return rule ? { content: [{ type: 'text', text: JSON.stringify((({ tokenFingerprint: _tokenFingerprint, ...safe }) => safe)(rule)) }] } : { content: [{ type: 'text', text: 'Automation not found.' }], isError: true };
  });

  server.registerTool('automation_enable', { description: 'Enable or disable one of the current token automations.', inputSchema: { id: z.string().uuid(), enabled: z.boolean() } }, async ({ id, enabled }) => {
    assertToolPermitted({ tool: 'automation_enable', scopes: ctx.token.scopes, readOnly: ctx.readOnly });
    if (ctx.readOnly) return { content: [{ type: 'text', text: 'Read-only mode: automation change refused.' }], isError: true };
    return setRuleEnabled(fp(ctx), id, enabled) ? { content: [{ type: 'text', text: `${enabled ? 'Enabled' : 'Disabled'} ${id}` }] } : { content: [{ type: 'text', text: 'Automation not found.' }], isError: true };
  });

  server.registerTool('automation_trigger', { description: 'Manually trigger an owned automation rule after evaluating its conditions.', inputSchema: { id: z.string().uuid(), data: z.record(z.unknown()).default({}) } }, async ({ id, data }) => {
    assertToolPermitted({ tool: 'automation_trigger', scopes: ctx.token.scopes, readOnly: ctx.readOnly });
    const rule = tokenRules(fp(ctx)).find(r => r.id === id);
    if (!rule) return { content: [{ type: 'text', text: 'Automation not found.' }], isError: true };
    if (ctx.readOnly) return { content: [{ type: 'text', text: 'Read-only mode: automation execution refused.' }], isError: true };
    if (rule.actions.some(a => FORBIDDEN_ACTIONS.has(a.tool))) return { content: [{ type: 'text', text: 'Automation contains a forbidden action.' }], isError: true };
    const event = { type: rule.trigger.type, tool: rule.trigger.tool, data, tokenFingerprint: fp(ctx), ts: Date.now(), origin: 'external' as const, depth: 0 };
    const { dispatchAutomationEvent } = await import('../core/automation-engine.js');
    await dispatchAutomationEvent(event, async (_r, action) => {
      if (FORBIDDEN_ACTIONS.has(action.tool)) throw new Error('Forbidden automation action');
      const target = ctx.invokeTool?.bind(ctx);
      if (!target) throw new Error('Tool invocation is unavailable in this context');
      const previousDepth = ctx.automationDepth || 0;
      ctx.automationDepth = previousDepth + 1;
      try { await target(action.tool, action.args); } finally { ctx.automationDepth = previousDepth; }
    }, ctx.cfg);
    return { content: [{ type: 'text', text: `Triggered ${id}` }] };
  });

  server.registerTool('automation_delete', { description: 'Delete one of the current token automations.', inputSchema: { id: z.string().uuid() } }, async ({ id }) => {
    assertToolPermitted({ tool: 'automation_delete', scopes: ctx.token.scopes, readOnly: ctx.readOnly });
    if (ctx.readOnly) return { content: [{ type: 'text', text: 'Read-only mode: automation deletion refused.' }], isError: true };
    return deleteRule(fp(ctx), id) ? { content: [{ type: 'text', text: `Deleted ${id}` }] } : { content: [{ type: 'text', text: 'Automation not found.' }], isError: true };
  });
}
