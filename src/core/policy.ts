import fs from 'node:fs';
import path from 'node:path';
import { normalizePathForCompare } from './platform.js';

export interface PolicyConfig {
  allowed_paths: string[];
  denied_paths: string[];
  shell_enabled: boolean;
  read_only?: boolean;
}

/** Tool groups — used for per-token scopes. */
export const TOOL_SCOPES: Record<string, string[]> = {
  filesystem: ['list_directory', 'read_file', 'write_file', 'edit_file', 'delete_path', 'search_code', 'file_info'],
  shell: ['run_command', 'process_list', 'kill_process'],
  system: ['system_info', 'disk_usage', 'network_interfaces'],
  http: ['http_request', 'port_check', 'web_fetch'],
  git: ['git'],
  sqlite: ['sqlite_query', 'sqlite_schema'],
  policy: ['list_allowed_paths', 'allow_path', 'deny_path', 'shell_enabled'],
  logs: ['tail_logs', 'search_logs', 'journal'],
  services: ['service_status', 'service_action'],
  packages: ['package_list', 'package_install', 'package_remove'],
  schedule: ['schedule_command', 'cancel_scheduled_task', 'list_scheduled_tasks'],
  project: ['analyze_project', 'project_health_check'],
  security: ['secret_scan', 'port_scan_local'],
  planning: ['create_task_plan', 'task_status', 'workspace_snapshot', 'rollback_changes'],
  formatting: ['format_python', 'lint_python'],
  documents: ['create_document'],
  ops: ['environment_inspect', 'nginx_inspect'],
};

/** Tools that mutate state — refused under read_only. */
export const MUTATING_TOOLS = new Set([
  'write_file', 'edit_file', 'delete_path', 'run_command', 'kill_process',
  'git', 'sqlite_query', 'allow_path', 'deny_path',
  'package_install', 'package_remove', 'service_action',
  'schedule_command', 'cancel_scheduled_task', 'workspace_snapshot', 'rollback_changes',
]);

/** Thrown by tools when a target path is outside the policy sandbox. */
export class PolicyError extends Error {
  constructor(public readonly target: string) {
    super(`Access to ${target} is not allowed by the path policy`);
    this.name = 'PolicyError';
  }
}

/** Thrown when a scope excludes the tool, or read-only blocks it. */
export class ScopeError extends Error {
  constructor(tool: string, why: string) {
    super(`Tool ${tool} is not permitted: ${why}`);
    this.name = 'ScopeError';
  }
}

/**
 * Resolve a path the way the tools will actually touch it:
 * absolute, symlink-free where possible, `..` collapsed.
 * For not-yet-existing targets (write case), the deepest existing ancestor
 * is resolved and the remainder re-attached — symlinked parents still collapse.
 *
 * Cross-platform: handles Windows drive roots (C:\) as well as POSIX /.
 */
export function resolveReal(p: string): string {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync(abs);
  } catch {
    let dir = abs;
    const parts: string[] = [];
    // path.dirname('C:\\') === 'C:\\' and dirname('/') === '/' — both terminate.
    while (!fs.existsSync(dir)) {
      const parent = path.dirname(dir);
      if (parent === dir) break; // reached a root that does not exist
      parts.unshift(path.basename(dir));
      dir = parent;
    }
    try {
      return path.join(fs.realpathSync(dir), ...parts);
    } catch {
      return abs;
    }
  }
}

function isWithin(child: string, ancestor: string): boolean {
  const c = normalizePathForCompare(child);
  const a = normalizePathForCompare(ancestor);
  if (c === a) return true;
  const prefix = a.endsWith('/') ? a : a + '/';
  return c.startsWith(prefix);
}

export function isPathAllowed(policy: PolicyConfig, p: string): boolean {
  const real = resolveReal(p);
  for (const deny of policy.denied_paths) {
    if (isWithin(real, resolveReal(deny))) return false;
  }
  if (policy.allowed_paths.length === 0) return false;
  for (const allow of policy.allowed_paths) {
    if (isWithin(real, resolveReal(allow))) return true;
  }
  return false;
}

/** Policy gate for filesystem tools — throws PolicyError when refused. */
export function assertAllowed(policy: PolicyConfig, p: string): void {
  if (!isPathAllowed(policy, p)) throw new PolicyError(p);
}

export function shellAllowed(policy: PolicyConfig): boolean {
  return policy.shell_enabled;
}

/** Map a tool name to its scope group (null = uncategorized). */
export function scopeOf(tool: string): string | null {
  for (const [group, tools] of Object.entries(TOOL_SCOPES)) {
    if (tools.includes(tool)) return group;
  }
  return null;
}

/** Full gate: scope + read-only + (for path tools) sandbox. */
export function assertToolPermitted(
  opts: { tool: string; scopes: string[]; readOnly: boolean; policy?: PolicyConfig; target?: string },
): void {
  const { tool, scopes, readOnly, policy, target } = opts;
  if (scopes.length > 0 && !scopes.includes(tool)) {
    const group = scopeOf(tool);
    if (!group || !scopes.includes(group)) {
      throw new ScopeError(tool, `outside token scopes (${scopes.join(', ')})`);
    }
  }
  if (readOnly && MUTATING_TOOLS.has(tool)) {
    throw new ScopeError(tool, 'read-only mode is active');
  }
  if (target !== undefined && policy) {
    assertAllowed(policy, target);
  }
}
