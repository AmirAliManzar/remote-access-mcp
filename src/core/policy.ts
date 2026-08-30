import fs from 'node:fs';
import path from 'node:path';

export interface PolicyConfig {
  allowed_paths: string[];
  denied_paths: string[];
  shell_enabled: boolean;
}

/** Thrown by tools when a target path is outside the policy sandbox. */
export class PolicyError extends Error {
  constructor(public readonly target: string) {
    super(`Access to ${target} is not allowed by the path policy`);
    this.name = 'PolicyError';
  }
}

/**
 * Resolve a path the way the tools will actually touch it:
 * absolute, symlink-free where possible, `..` collapsed.
 * For not-yet-existing targets (write case), the deepest existing ancestor
 * is resolved and the remainder re-attached — symlinked parents still collapse.
 */
export function resolveReal(p: string): string {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync(abs);
  } catch {
    let dir = abs;
    const parts: string[] = [];
    while (dir !== '/' && !fs.existsSync(dir)) {
      parts.unshift(path.basename(dir));
      dir = path.dirname(dir);
    }
    try {
      return path.join(fs.realpathSync(dir), ...parts);
    } catch {
      return abs;
    }
  }
}

function isWithin(child: string, ancestor: string): boolean {
  if (child === ancestor) return true;
  const a = ancestor.endsWith('/') ? ancestor : ancestor + '/';
  return child.startsWith(a);
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
