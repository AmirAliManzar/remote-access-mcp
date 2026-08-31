import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../core/context.js';
import { integrations, zodFromJsonSchema } from '../core/integrations.js';

function safeName(name: string): string {
    return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Register external MCP integrations as namespaced proxy tools.
 *
 * Context7 and codebase-memory are MIT-licensed MCP servers and are safe to
 * expose through Remote Access MCP. context-mode is deliberately not proxied:
 * its Elastic License 2.0 forbids offering the software as a hosted/managed
 * service. It remains an optional local plugin dependency instead.
 */
export async function registerIntegrationTools(server: McpServer, _ctx: ToolContext): Promise<void> {
    const targets = [
        { name: 'context7' as const, prefix: 'context7' },
        ...(process.env.RAMCP_ENABLE_CODEBASE_MEMORY === '1'
            ? [{ name: 'codebase-memory' as const, prefix: 'codebase_memory' }]
            : []),
    ];

    for (const target of targets) {
        try {
            const tools = await integrations.list(target.name);
            for (const tool of tools) {
                const exposedName = `${target.prefix}_${safeName(tool.name)}`;
                const inputSchema = zodFromJsonSchema(tool.inputSchema);
                server.registerTool(
                    exposedName,
                    {
                        title: tool.title || tool.name,
                        description: tool.description
                            ? `[${target.name}] ${tool.description}`
                            : `[${target.name}] ${tool.name}`,
                        inputSchema,
                        _meta: {
                            'remote-access-mcp.integration': target.name,
                            'remote-access-mcp.upstream-tool': tool.name,
                        },
                    },
                    async (args) => {
                        try {
                            const result = await integrations.call(target.name, tool.name, args as Record<string, unknown>);
                            return result as any;
                        } catch (error: any) {
                            return {
                                content: [{
                                    type: 'text',
                                    text: `[${target.name}] ${error?.message || 'integration request failed'}`,
                                }],
                                isError: true,
                            };
                        }
                    },
                );
            }
        } catch (error) {
            // Optional integrations must never make the core gateway unavailable.
            const message = error instanceof Error ? error.message : String(error);
            console.warn(`[integration:${target.name}] unavailable:`, message);
        }
    }
}
