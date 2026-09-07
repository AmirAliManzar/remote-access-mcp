import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../core/context.js';
import { assertToolPermitted } from '../core/policy.js';
import { AuditLog } from '../core/audit.js';
import { analyzeSecurity } from '../core/security-analysis.js';
import { decideAutonomy } from '../core/autonomy.js';
import { createRecoveryRule, listRecoveryRules, deleteRecoveryRule, listIncidents, claimRecovery, markIncident, resetRecoveryAttempts, type RecoveryRule } from '../core/recovery-engine.js';

const forbidden = new Set(['task_approve','approval_decide','plugin_install','plugin_remove','automation_create','automation_enable','automation_delete','automation_trigger','recovery_rule_create','recovery_rule_delete','recovery_trigger']);
const fp = (ctx: ToolContext) => AuditLog.fingerprint(ctx.token.token);
const policy = (ctx: ToolContext) => ({ enabled: process.env.RAMCP_AUTONOMOUS === '1', allowAutonomousHighRisk: process.env.RAMCP_AUTONOMOUS_HIGH_RISK === '1', allowAutonomousCritical: process.env.RAMCP_AUTONOMOUS_CRITICAL === '1' });

export function registerAutonomousTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool('security_analysis', { description: 'Run a bounded read-only security posture analysis for the current token.', inputSchema: {} }, async () => {
    assertToolPermitted({ tool: 'security_analysis', scopes: ctx.token.scopes, readOnly: ctx.readOnly });
    return { content: [{ type: 'text', text: JSON.stringify(analyzeSecurity({ scopes: ctx.token.scopes, readOnly: ctx.readOnly, shellEnabled: ctx.token.shell_enabled, allowedPaths: ctx.token.allowed_paths, deniedPaths: ctx.token.denied_paths })) }] };
  });
  server.registerTool('autonomy_check', { description: 'Evaluate whether an action risk may execute at a requested autonomy level.', inputSchema: { autonomy: z.enum(['readonly','safe','supervised','autonomous']), risk: z.enum(['none','low','medium','high','critical']) } }, async ({ autonomy, risk }) => {
    assertToolPermitted({ tool: 'autonomy_check', scopes: ctx.token.scopes, readOnly: ctx.readOnly });
    return { content: [{ type: 'text', text: JSON.stringify({ decision: decideAutonomy(autonomy, risk, policy(ctx)), autonomous_enabled: process.env.RAMCP_AUTONOMOUS === '1' }) }] };
  });
  server.registerTool('recovery_rule_create', { description: 'Create a bounded token-isolated self-healing rule for one known failure type.', inputSchema: { name: z.string().min(1).max(100), failure_type: z.string().min(1).max(100), risk: z.enum(['low','medium','high','critical']).default('medium'), action: z.object({ tool: z.string().min(1).max(100), args: z.record(z.unknown()).default({}) }), max_attempts: z.number().int().min(1).max(5).default(3), cooldown_seconds: z.number().int().min(30).max(86400).default(300) } }, async ({ name, failure_type, risk, action, max_attempts, cooldown_seconds }) => {
    assertToolPermitted({ tool: 'recovery_rule_create', scopes: ctx.token.scopes, readOnly: ctx.readOnly });
    if (forbidden.has(action.tool)) return { content: [{ type: 'text', text: 'Forbidden recovery action.' }], isError: true };
    if (JSON.stringify(action.args).length > 64 * 1024) return { content: [{ type: 'text', text: 'Recovery action args exceed 64 KiB.' }], isError: true };
    try { assertToolPermitted({ tool: action.tool, scopes: ctx.token.scopes, readOnly: ctx.readOnly }); } catch (e: any) { return { content: [{ type: 'text', text: e.message }], isError: true }; }
    const r = createRecoveryRule({ tokenFingerprint: fp(ctx), name, failureType: failure_type, risk, action, enabled: true, maxAttempts: max_attempts, cooldownSeconds: cooldown_seconds });
    return { content: [{ type: 'text', text: JSON.stringify({ id: r.id, name: r.name, failure_type: r.failureType }) }] };
  });
  server.registerTool('recovery_rule_list', { description: 'List recovery rules owned by the current token.', inputSchema: {} }, async () => {
    assertToolPermitted({ tool: 'recovery_rule_list', scopes: ctx.token.scopes, readOnly: ctx.readOnly });
    return { content: [{ type: 'text', text: JSON.stringify(listRecoveryRules(fp(ctx)).map(({ tokenFingerprint: _x, ...r }) => r)) }] };
  });
  server.registerTool('recovery_rule_delete', { description: 'Delete an owned recovery rule.', inputSchema: { id: z.string().uuid() } }, async ({ id }) => {
    assertToolPermitted({ tool: 'recovery_rule_delete', scopes: ctx.token.scopes, readOnly: ctx.readOnly });
    return deleteRecoveryRule(fp(ctx), id) ? { content: [{ type: 'text', text: `Deleted ${id}` }] } : { content: [{ type: 'text', text: 'Recovery rule not found.' }], isError: true };
  });
  server.registerTool('recovery_incidents', { description: 'List token-isolated self-healing incidents.', inputSchema: {} }, async () => {
    assertToolPermitted({ tool: 'recovery_incidents', scopes: ctx.token.scopes, readOnly: ctx.readOnly });
    return { content: [{ type: 'text', text: JSON.stringify(listIncidents(fp(ctx)).map(({ tokenFingerprint: _x, ...r }) => r)) }] };
  });
  server.registerTool('recovery_trigger', { description: 'Run one owned recovery rule once, subject to cooldown, attempt limits, autonomy, and normal tool policy.', inputSchema: { id: z.string().uuid() } }, async ({ id }) => {
    assertToolPermitted({ tool: 'recovery_trigger', scopes: ctx.token.scopes, readOnly: ctx.readOnly });
    if (ctx.readOnly) return { content: [{ type: 'text', text: 'Read-only mode blocks recovery execution.' }], isError: true };
    const r = listRecoveryRules(fp(ctx)).find(x => x.id === id);
    if (!r) return { content: [{ type: 'text', text: 'Recovery rule not found.' }], isError: true };
    const decision = decideAutonomy('autonomous', r.risk, policy(ctx));
    if (decision !== 'allow') return { content: [{ type: 'text', text: `Recovery denied: ${decision}. Enable autonomous operations explicitly or use supervised approval outside this trigger.` }], isError: true };
    const claimed = claimRecovery(fp(ctx), id);
    if (!claimed) return { content: [{ type: 'text', text: 'Recovery is rate-limited, exhausted, disabled, or already claimed.' }], isError: true };
    markIncident(fp(ctx), claimed, 'open');
    try {
      if (forbidden.has(claimed.action.tool)) throw new Error('Forbidden recovery action');
      if (!ctx.invokeTool) throw new Error('Tool invocation is unavailable');
      const result = await ctx.invokeTool(claimed.action.tool, claimed.action.args);
      if (result?.isError) throw new Error('Recovery action returned an error');
      markIncident(fp(ctx), claimed, 'recovered');
      return { content: [{ type: 'text', text: JSON.stringify({ recovered: true, id }) }] };
    } catch (e: any) {
      markIncident(fp(ctx), claimed, 'failed', e.message || String(e));
      return { content: [{ type: 'text', text: e.message || String(e) }], isError: true };
    }
  });
  server.registerTool('recovery_reset', { description: 'Reset the bounded attempt counter of an owned recovery rule.', inputSchema: { id: z.string().uuid() } }, async ({ id }) => {
    assertToolPermitted({ tool: 'recovery_rule_delete', scopes: ctx.token.scopes, readOnly: ctx.readOnly });
    resetRecoveryAttempts(fp(ctx), id);
    return { content: [{ type: 'text', text: `Reset ${id}` }] };
  });
}
