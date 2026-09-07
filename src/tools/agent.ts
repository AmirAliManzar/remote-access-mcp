import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../core/context.js';
import { assertToolPermitted } from '../core/policy.js';
import { getAgentProfile, listAgentProfiles } from '../core/agent-profiles.js';

export function registerAgentTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool('agent_profiles', {
    description: 'List specialized task-agent profiles and their allowed capability scopes.',
    inputSchema: { id: z.string().optional() },
  }, async ({ id }) => {
    assertToolPermitted({ tool: 'agent_profiles', scopes: ctx.token.scopes, readOnly: ctx.readOnly });
    const value = id ? getAgentProfile(id) : listAgentProfiles();
    if (!value) return { content: [{ type: 'text', text: `Agent profile ${id} not found.` }], isError: true };
    return { content: [{ type: 'text', text: JSON.stringify(value) }] };
  });
}
