import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../core/context.js';
import { assertToolPermitted } from '../core/policy.js';

export function registerContextTools(server: McpServer, ctx: ToolContext): void {
  const engine = ctx.contextEngine;
  if (!engine) return;

  server.registerTool('context_stats', {
    description: 'Show context-engine mode, cache, memory and byte-saving statistics for the current token.',
    inputSchema: {},
  }, async () => {
    assertToolPermitted({ tool: 'context_stats', scopes: ctx.token.scopes, readOnly: ctx.readOnly });
    return { content: [{ type: 'text', text: JSON.stringify(engine.getStats()) }] };
  });

  server.registerTool('context_memory', {
    description: 'Return recent compact task memory for the current token only.',
    inputSchema: { limit: z.number().int().min(1).max(64).optional() },
  }, async ({ limit }) => {
    assertToolPermitted({ tool: 'context_memory', scopes: ctx.token.scopes, readOnly: ctx.readOnly });
    return { content: [{ type: 'text', text: JSON.stringify(engine.recentMemory(limit)) }] };
  });

  server.registerTool('context_snapshot', {
    description: 'Save a context snapshot for the current token and return a short snapshot id.',
    inputSchema: { text: z.string().describe('Text to snapshot') },
  }, async ({ text }) => {
    assertToolPermitted({ tool: 'context_snapshot', scopes: ctx.token.scopes, readOnly: ctx.readOnly });
    return { content: [{ type: 'text', text: JSON.stringify({ id: engine.snapshot(text) }) }] };
  });

  server.registerTool('context_diff', {
    description: 'Compare text with a saved context snapshot and return a compact line diff.',
    inputSchema: { id: z.string(), text: z.string() },
  }, async ({ id, text }) => {
    assertToolPermitted({ tool: 'context_diff', scopes: ctx.token.scopes, readOnly: ctx.readOnly });
    const diff = engine.diffSnapshot(id, text);
    return { content: [{ type: 'text', text: JSON.stringify(diff) }], isError: !diff.found };
  });

  server.registerTool('context_budget', {
    description: 'Compact arbitrary text to an explicit context-character budget.',
    inputSchema: { text: z.string(), max_chars: z.number().int().min(1).max(1_000_000) },
  }, async ({ text, max_chars }) => {
    assertToolPermitted({ tool: 'context_budget', scopes: ctx.token.scopes, readOnly: ctx.readOnly });
    const result = engine.fitBudget({ content: [{ type: 'text', text }] }, max_chars);
    return { content: result.content };
  });

  server.registerTool('context_clear', {
    description: 'Clear this token\'s local context cache and task memory.',
    inputSchema: {},
  }, async () => {
    assertToolPermitted({ tool: 'context_clear', scopes: ctx.token.scopes, readOnly: ctx.readOnly });
    engine.clear();
    return { content: [{ type: 'text', text: 'Context cache and memory cleared for this token.' }] };
  });
}
