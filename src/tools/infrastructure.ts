import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../core/context.js';
import { assertToolPermitted } from '../core/policy.js';

const execFileAsync = promisify(execFile);
const MAX_OUTPUT = 128 * 1024;

function cleanOutput(stdout: string, stderr: string): string {
  const out = `${stdout}${stderr ? `\n${stderr}` : ''}`.trim();
  return out.slice(0, MAX_OUTPUT);
}

async function fixedExec(file: string, args: string[], timeout = 20_000): Promise<string> {
  try {
    const r = await execFileAsync(file, args, { timeout, maxBuffer: MAX_OUTPUT * 2, windowsHide: true });
    return cleanOutput(r.stdout, r.stderr);
  } catch (e: any) {
    const detail = cleanOutput(String(e?.stdout || ''), String(e?.stderr || ''));
    if (e?.code === 'ENOENT') throw new Error(`${file} is not installed or not in PATH`);
    throw new Error(`${file} failed${detail ? `: ${detail}` : ` (exit ${e?.code ?? 'unknown'})`}`);
  }
}

function name(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)) throw new Error('Invalid resource name');
  return value;
}

function namespace(value?: string): string[] {
  if (!value) return [];
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(value)) throw new Error('Invalid namespace');
  return ['-n', value];
}

export function registerInfrastructureTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool('infra_probe', {
    description: 'Probe availability and versions of Docker, kubectl, and cloudflared without changing the host.',
    inputSchema: {},
  }, async () => {
    assertToolPermitted({ tool: 'infra_probe', scopes: ctx.token.scopes, readOnly: ctx.readOnly });
    const tools = ['docker', 'kubectl', 'cloudflared'];
    const result: Record<string, string> = {};
    for (const tool of tools) {
      try { result[tool] = await fixedExec(tool, ['--version'], 5_000); }
      catch (e: any) { result[tool] = `unavailable: ${e.message}`; }
    }
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  });

  server.registerTool('docker_ps', {
    description: 'List Docker containers. Read-only and shell-free.',
    inputSchema: { all: z.boolean().optional().default(true) },
  }, async ({ all }) => {
    assertToolPermitted({ tool: 'docker_ps', scopes: ctx.token.scopes, readOnly: ctx.readOnly });
    return { content: [{ type: 'text', text: await fixedExec('docker', ['ps', '--no-trunc', ...(all ? ['-a'] : [])]) }] };
  });

  server.registerTool('docker_inspect', {
    description: 'Inspect one Docker container by name or ID.',
    inputSchema: { container: z.string().min(1).max(128) },
  }, async ({ container }) => {
    assertToolPermitted({ tool: 'docker_inspect', scopes: ctx.token.scopes, readOnly: ctx.readOnly });
    return { content: [{ type: 'text', text: await fixedExec('docker', ['inspect', name(container)]) }] };
  });

  server.registerTool('docker_logs', {
    description: 'Read recent Docker container logs.',
    inputSchema: { container: z.string().min(1).max(128), tail: z.number().int().min(1).max(5000).optional().default(200) },
  }, async ({ container, tail }) => {
    assertToolPermitted({ tool: 'docker_logs', scopes: ctx.token.scopes, readOnly: ctx.readOnly });
    return { content: [{ type: 'text', text: await fixedExec('docker', ['logs', '--tail', String(tail), name(container)]) }] };
  });

  server.registerTool('docker_action', {
    description: 'Start, stop, or restart one Docker container. Requires mutation permission.',
    inputSchema: { action: z.enum(['start', 'stop', 'restart']), container: z.string().min(1).max(128) },
  }, async ({ action, container }) => {
    assertToolPermitted({ tool: 'docker_action', scopes: ctx.token.scopes, readOnly: ctx.readOnly });
    return { content: [{ type: 'text', text: await fixedExec('docker', [action, name(container)]) }] };
  });

  server.registerTool('kubernetes_get', {
    description: 'Read Kubernetes resources with kubectl get. No arbitrary kubectl flags.',
    inputSchema: { resource: z.enum(['pods', 'deployments', 'services', 'statefulsets', 'daemonsets', 'jobs', 'cronjobs', 'nodes', 'namespaces']), namespace: z.string().max(63).optional(), name: z.string().max(128).optional() },
  }, async ({ resource, namespace: ns, name: item }) => {
    assertToolPermitted({ tool: 'kubernetes_get', scopes: ctx.token.scopes, readOnly: ctx.readOnly });
    const args = ['get', resource, '-o', 'wide', ...namespace(ns)];
    if (item) args.push(name(item));
    return { content: [{ type: 'text', text: await fixedExec('kubectl', args) }] };
  });

  server.registerTool('kubernetes_describe', {
    description: 'Describe a Kubernetes resource using a fixed kubectl command.',
    inputSchema: { resource: z.enum(['pod', 'deployment', 'service', 'statefulset', 'daemonset', 'job', 'cronjob']), name: z.string().min(1).max(128), namespace: z.string().max(63).optional() },
  }, async ({ resource, name: item, namespace: ns }) => {
    assertToolPermitted({ tool: 'kubernetes_describe', scopes: ctx.token.scopes, readOnly: ctx.readOnly });
    return { content: [{ type: 'text', text: await fixedExec('kubectl', ['describe', resource, name(item), ...namespace(ns)]) }] };
  });

  server.registerTool('kubernetes_logs', {
    description: 'Read recent logs from a Kubernetes pod/container.',
    inputSchema: { pod: z.string().min(1).max(128), container: z.string().max(128).optional(), namespace: z.string().max(63).optional(), tail: z.number().int().min(1).max(5000).optional().default(200) },
  }, async ({ pod, container, namespace: ns, tail }) => {
    assertToolPermitted({ tool: 'kubernetes_logs', scopes: ctx.token.scopes, readOnly: ctx.readOnly });
    const args = ['logs', name(pod), '--tail', String(tail), ...namespace(ns)];
    if (container) args.push('-c', name(container));
    return { content: [{ type: 'text', text: await fixedExec('kubectl', args) }] };
  });

  server.registerTool('cloudflare_status', {
    description: 'Inspect cloudflared version and configured tunnel visibility. Never returns credentials.',
    inputSchema: {},
  }, async () => {
    assertToolPermitted({ tool: 'cloudflare_status', scopes: ctx.token.scopes, readOnly: ctx.readOnly });
    const version = await fixedExec('cloudflared', ['--version']);
    let tunnels = 'tunnel list unavailable';
    try { tunnels = await fixedExec('cloudflared', ['tunnel', 'list'], 15_000); } catch (e: any) { tunnels = e.message; }
    return { content: [{ type: 'text', text: `version:\n${version}\n\ntunnels:\n${tunnels}` }] };
  });
}
