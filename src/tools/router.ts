import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../core/context.js';
import { authorizedCapabilities, capabilityCategories } from '../core/capability-router.js';
import { MUTATING_TOOLS } from '../core/policy.js';

export function registerRouterTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool('capability_discover', {
    description: 'Discover only the capabilities available to the current token. Use query/category/cost to keep context small.',
    inputSchema: {
      query: z.string().optional(),
      category: z.string().optional(),
      max_cost: z.number().int().min(1).max(100).optional(),
      limit: z.number().int().min(1).max(128).optional(),
    },
  }, async ({ query, category, max_cost, limit }) => {
    const result = authorizedCapabilities(ctx.token.scopes, { query, category, maxCost: max_cost, limit });
    return { content: [{ type: 'text', text: JSON.stringify({ count: result.length, categories: capabilityCategories(), capabilities: result }) }] };
  });

  server.registerTool('capability_batch', {
    description: 'Run multiple independent read-only tool calls in parallel. Maximum 8 calls; mutating tools are rejected.',
    inputSchema: {
      calls: z.array(z.object({ name: z.string(), arguments: z.record(z.unknown()).optional() })).min(1).max(8),
    },
  }, async ({ calls }) => {
    if (!ctx.invokeTool) return { content: [{ type: 'text', text: 'Capability batch executor is unavailable.' }], isError: true };
    const denied = calls.filter(c => MUTATING_TOOLS.has(c.name) || c.name === 'approval_decide' || c.name === 'capability_batch');
    if (denied.length) return { content: [{ type: 'text', text: `Batch accepts read-only calls only: ${denied.map(c => c.name).join(', ')}` }], isError: true };
    const results = await Promise.all(calls.map(async c => {
      try { return { name: c.name, ok: true, result: await ctx.invokeTool!(c.name, c.arguments || {}) }; }
      catch (e: any) { return { name: c.name, ok: false, error: e?.message || 'tool error' }; }
    }));
    return { content: [{ type: 'text', text: JSON.stringify({ results }) }] };
  });
}
