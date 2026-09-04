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
  jobs: ['run_background', 'job_status', 'job_output', 'job_list', 'job_cancel', 'run_parallel'],
  transfer: ['upload_file', 'download_file'],
  diagnostics: ['system_diagnostics', 'diagnose_service'],
  monitoring: ['health_watch', 'health_status', 'health_stop'],
  database: ['database_query', 'database_schema'],
  changes: ['change_set_begin', 'change_set_add', 'change_set_status', 'change_set_commit', 'change_set_rollback'],
  resources: ['system_resource', 'services_resource', 'network_resource', 'projects_resource', 'audit_resource'],
  prompts: ['diagnose_prompt', 'deploy_prompt', 'security_audit_prompt', 'inspect_project_prompt'],
  plugins: ['plugin_list', 'plugin_install', 'plugin_remove'],
  approvals: ['approval_decide'],
};

/** Tools that mutate state — refused under read_only. */
export const MUTATING_TOOLS = new Set([
  'write_file', 'edit_file', 'delete_path', 'run_command', 'kill_process',
  'git', 'sqlite_query', 'allow_path', 'deny_path',
  'package_install', 'package_remove', 'service_action',
  'schedule_command', 'cancel_scheduled_task', 'workspace_snapshot', 'rollback_changes',
  'run_background', 'job_cancel', 'run_parallel', 'upload_file',
  'package_install', 'package_remove', 'service_action', 'change_set_begin', 'change_set_add', 'change_set_commit', 'change_set_rollback',
  'health_watch', 'health_stop', 'plugin_install', 'plugin_remove',
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
export interface CommandPolicy { command_allowlist?: string[]; approval_mode?: 'auto' | 'approval-required'; }

/**
 * Return every executable token represented by a shell command.
 * The allowlist is executable-oriented, so shell control operators,
 * substitutions and chained commands are rejected rather than attempting
 * to parse an entire shell language imperfectly.
 */
function commandHasShellOperators(command: string): boolean {
  let quote: string | null = null;
  let escaped = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\' && quote !== "'") { escaped = true; continue; }
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === ';' || ch === '|' || ch === '`' || ch === '$' || ch === '<' || ch === '>' || ch === '\n' || ch === '\r') return true;
    if (ch === '&') return true;
  }
  return false;
}

function commandExecutable(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) return '';
  // A command with shell syntax is intentionally handled by the caller.
  // For simple commands, the first whitespace-delimited token is the executable.
  return trimmed.split(/\s+/)[0]?.replace(/^.*[\\/]/, '') || '';
}

export function assertCommandPolicy(policy: CommandPolicy, command: string, approved = false): void {
  if (policy.approval_mode === 'approval-required' && !approved) {
    throw new ScopeError('run_command', 'approval is required for command execution');
  }
  const trimmed = command.trim();
  if (!trimmed) throw new ScopeError('run_command', 'command must not be empty');
  const list = policy.command_allowlist || [];
  if (!list.length) return;

  // Exact command entries remain supported. Otherwise the command must be a
  // single simple invocation whose executable is explicitly allowlisted.
  if (list.includes(trimmed)) return;
  if (commandHasShellOperators(trimmed)) {
    throw new ScopeError('run_command', 'shell operators are not allowed when a command allowlist is active; allow the exact command instead');
  }
  const executable = commandExecutable(trimmed);
  if (!list.includes(executable)) {
    throw new ScopeError('run_command', `command is not in the allowlist (${list.join(', ')})`);
  }
}

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
