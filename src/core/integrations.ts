import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import path from 'node:path';
import { z } from 'zod';

export type IntegrationName = 'context7' | 'codebase-memory';

interface IntegrationClient {
    client: Client;
    transport: StdioClientTransport;
    tools: Tool[];
}

function zodFromJsonSchema(schema: any): z.ZodTypeAny {
    if (!schema || typeof schema !== 'object') return z.any();

    if (schema.$ref) return z.any();

    if (Array.isArray(schema.enum) && schema.enum.length > 0) {
        const values = schema.enum;
        if (values.every((v: unknown): v is string => typeof v === 'string')) {
            return z.enum(values as [string, ...string[]]);
        }
        if (values.length === 1) return z.literal(values[0] as any);
    }

    if (schema.const !== undefined) return z.literal(schema.const as any);

    if (Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf)) {
        const variants = (schema.oneOf || schema.anyOf).map((s: any) => zodFromJsonSchema(s));
        if (variants.length === 1) return variants[0];
        if (variants.length > 2) return z.union(variants as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
        if (variants.length === 2) return z.union(variants as [z.ZodTypeAny, z.ZodTypeAny]);
    }

    if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
        return zodFromJsonSchema(schema.allOf[0]);
    }

    let result: z.ZodTypeAny;
    switch (schema.type) {
        case 'object': {
            const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
            const required = new Set(Array.isArray(schema.required) ? schema.required : []);
            const shape: Record<string, z.ZodTypeAny> = {};
            for (const [key, value] of Object.entries(properties)) {
                const child = zodFromJsonSchema(value);
                shape[key] = required.has(key) ? child : child.optional();
            }
            const object = z.object(shape);
            result = schema.additionalProperties === false ? object : object.passthrough();
            break;
        }
        case 'array':
            result = z.array(zodFromJsonSchema(schema.items));
            break;
        case 'string': {
            let stringSchema = z.string();
            if (typeof schema.minLength === 'number') stringSchema = stringSchema.min(schema.minLength);
            if (typeof schema.maxLength === 'number') stringSchema = stringSchema.max(schema.maxLength);
            result = stringSchema;
            break;
        }
        case 'integer':
            result = z.number().int();
            break;
        case 'number':
            result = z.number();
            break;
        case 'boolean':
            result = z.boolean();
            break;
        case 'null':
            result = z.null();
            break;
        default:
            result = z.any();
            break;
    }

    if (schema.nullable === true) result = result.nullable();
    if (typeof schema.description === 'string') result = result.describe(schema.description);
    return result;
}

function packageScript(packageName: string, relativeEntry: string): string {
    return new URL(`../../node_modules/${packageName}/${relativeEntry}`, import.meta.url).pathname;
}

class IntegrationManager {
    private readonly clients = new Map<IntegrationName, Promise<IntegrationClient>>();

    async get(name: IntegrationName): Promise<IntegrationClient> {
        let pending = this.clients.get(name);
        if (!pending) {
            pending = this.start(name);
            this.clients.set(name, pending);
        }
        return pending;
    }

    private async start(name: IntegrationName): Promise<IntegrationClient> {
        const env = Object.fromEntries(
            Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
        );
        const config = name === 'context7'
            ? {
                command: process.execPath,
                args: [packageScript('@upstash/context7-mcp', 'dist/index.js')],
                env,
            }
            : (() => {
                // Codebase Memory gets a private runtime owned by Remote Access MCP.
                // Never inherit the service user's normal HOME/cache/config: other
                // agents on the host may have their own Codebase Memory instances.
                const runtimeRoot = process.env.RAMCP_CODEBASE_RUNTIME || '/var/lib/remote-access-mcp/codebase-memory';
                const runtimeHome = process.env.RAMCP_CODEBASE_HOME || path.join(runtimeRoot, 'home');
                const runtimeCache = process.env.RAMCP_CODEBASE_CACHE || path.join(runtimeRoot, 'cache');
                const runtimeData = process.env.RAMCP_CODEBASE_DATA || path.join(runtimeRoot, 'data');
                const isolatedEnv = {
                    ...env,
                    HOME: runtimeHome,
                    XDG_CACHE_HOME: runtimeCache,
                    XDG_DATA_HOME: runtimeData,
                    CODEBASE_MEMORY_HOME: runtimeHome,
                };
                return {
                    command: process.execPath,
                    args: [packageScript('codebase-memory-mcp', 'bin.js')],
                    cwd: process.env.RAMCP_CODEBASE_ROOT || process.cwd(),
                    env: isolatedEnv,
                };
            })();

        const transport = new StdioClientTransport(config);
        const client = new Client({ name: 'remote-access-mcp', version: 'integration' });
        await client.connect(transport);
        const listed = await client.listTools();

        return { client, transport, tools: listed.tools };
    }

    async call(name: IntegrationName, toolName: string, args: Record<string, unknown>): Promise<any> {
        if (name === 'codebase-memory' && toolName === 'index_repository') {
            const root = path.resolve(process.env.RAMCP_CODEBASE_ROOT || process.cwd());
            const requested = path.resolve(String(args.repo_path || root));
            if (requested !== root && !requested.startsWith(`${root}${path.sep}`)) {
                throw new Error(`codebase-memory index_repository is restricted to ${root}`);
            }
            args = { ...args, repo_path: requested };
        }
        const integration = await this.get(name);
        return integration.client.callTool({ name: toolName, arguments: args });
    }

    async list(name: IntegrationName): Promise<Tool[]> {
        return (await this.get(name)).tools;
    }
}

export const integrations = new IntegrationManager();
export { zodFromJsonSchema };
