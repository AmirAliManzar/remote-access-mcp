import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
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

export interface CodebaseMemoryRuntimePaths {
    root: string;
    home: string;
    cache: string;
    data: string;
    runtime: string;
    binDir: string;
    bin: string;
    workspace: string;
}

/**
 * Resolve the complete private filesystem layout for this gateway's
 * Codebase Memory instance. These paths intentionally never fall back to the
 * service user's normal HOME/XDG directories.
 */
export function resolveCodebaseMemoryRuntimePaths(env: NodeJS.ProcessEnv = process.env): CodebaseMemoryRuntimePaths {
    const root = env.RAMCP_CODEBASE_RUNTIME || '/var/lib/remote-access-mcp/codebase-memory';
    return {
        root,
        home: env.RAMCP_CODEBASE_HOME || path.join(root, 'home'),
        cache: env.RAMCP_CODEBASE_CACHE || path.join(root, 'cache'),
        data: env.RAMCP_CODEBASE_DATA || path.join(root, 'data'),
        runtime: path.join(root, 'runtime'),
        binDir: path.join(root, 'bin'),
        bin: path.join(root, 'bin', 'codebase-memory-mcp'),
        workspace: env.RAMCP_CODEBASE_WORKSPACE || path.join(root, 'workspace'),
    };
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
                const paths = resolveCodebaseMemoryRuntimePaths(process.env);
                const sourceBin = packageScript('codebase-memory-mcp', 'bin/codebase-memory-mcp');
                fs.mkdirSync(paths.home, { recursive: true, mode: 0o750 });
                fs.mkdirSync(paths.cache, { recursive: true, mode: 0o750 });
                fs.mkdirSync(paths.data, { recursive: true, mode: 0o750 });
                fs.mkdirSync(paths.binDir, { recursive: true, mode: 0o750 });
                const sourceStat = fs.statSync(sourceBin);
                let needsRefresh = true;
                try {
                    const runtimeStat = fs.statSync(paths.bin);
                    needsRefresh = runtimeStat.size !== sourceStat.size || runtimeStat.mtimeMs !== sourceStat.mtimeMs;
                } catch {
                    needsRefresh = true;
                }
                if (needsRefresh) {
                    const staged = `${paths.bin}.new`;
                    fs.copyFileSync(sourceBin, staged);
                    fs.chmodSync(staged, 0o750);
                    fs.renameSync(staged, paths.bin);
                }
                fs.chmodSync(paths.bin, 0o750);
                try {
                    fs.chownSync(paths.home, 995, 987);
                    fs.chownSync(paths.cache, 995, 987);
                    fs.chownSync(paths.data, 995, 987);
                    fs.chownSync(paths.binDir, 995, 987);
                    fs.chownSync(paths.bin, 995, 987);
                } catch {
                    // Non-root local development can still use the isolated runtime.
                }
                const isolatedEnv = {
                    ...env,
                    HOME: paths.home,
                    XDG_CACHE_HOME: paths.cache,
                    XDG_DATA_HOME: paths.data,
                    CODEBASE_MEMORY_HOME: paths.home,
                    CBM_CACHE_DIR: paths.cache,
                    CBM_RUNTIME_DIR: paths.runtime,
                    CBM_ALLOWED_ROOT: paths.workspace,
                    CBM_MEM_BUDGET_MB: process.env.RAMCP_CODEBASE_MEM_BUDGET_MB || '512',
                    CBM_WORKERS: process.env.RAMCP_CODEBASE_WORKERS || '1',
                    CBM_LOG_LEVEL: process.env.RAMCP_CODEBASE_LOG_LEVEL || 'warn',
                };
                fs.mkdirSync(paths.runtime, { recursive: true, mode: 0o750 });
                fs.mkdirSync(paths.workspace, { recursive: true, mode: 0o750 });
                try { fs.chownSync(paths.workspace, 995, 987); } catch { /* non-root */ }
                try { fs.chownSync(paths.runtime, 995, 987); } catch { /* non-root */ }
                return {
                    command: '/usr/sbin/runuser',
                    args: ['-u', 'remote-access-mcp', '--', paths.bin],
                    cwd: paths.workspace,
                    env: isolatedEnv,
                };
            })();

        const transport = new StdioClientTransport(config);
        const client = new Client({ name: 'remote-access-mcp', version: 'integration' });
        await client.connect(transport);
        const listed = await client.listTools();

        return { client, transport, tools: listed.tools };
    }

    private syncWorkspace(sourceRoot: string, workspaceRoot: string): void {
        fs.mkdirSync(workspaceRoot, { recursive: true, mode: 0o750 });
        const result = spawnSync('/usr/bin/rsync', [
            '-a', '--delete', '--delete-excluded',
            '--exclude=.git/', '--exclude=node_modules/', '--exclude=dist/',
            '--exclude=runtime/', '--exclude=.cache/',
            `${sourceRoot}/`, `${workspaceRoot}/`,
        ], { stdio: 'pipe' });
        if (result.error || result.status !== 0) {
            const stderr = result.stderr?.toString().trim() || result.error?.message || 'rsync failed';
            throw new Error(`failed to refresh isolated codebase workspace: ${stderr}`);
        }
        try { fs.chownSync(workspaceRoot, 995, 987); } catch { /* non-root */ }
    }

    async call(name: IntegrationName, toolName: string, args: Record<string, unknown>): Promise<any> {
        if (name === 'codebase-memory' && toolName === 'index_repository') {
            const root = path.resolve(process.env.RAMCP_CODEBASE_ROOT || process.cwd());
            const requested = path.resolve(String(args.repo_path || root));
            if (requested !== root && !requested.startsWith(`${root}${path.sep}`)) {
                throw new Error(`codebase-memory index_repository is restricted to ${root}`);
            }
            const workspace = path.resolve(
                process.env.RAMCP_CODEBASE_WORKSPACE || '/var/lib/remote-access-mcp/codebase-memory/workspace',
            );
            this.syncWorkspace(root, workspace);
            args = { ...args, repo_path: workspace };
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
