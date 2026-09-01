import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/**
 * Fleet: run tools on remote machines over SSH.
 *
 * Design decisions, deliberately narrow:
 *
 *  - Outbound SSH only. The gateway machine holds one private key; remote
 *    machines need nothing installed except an SSH server and a POSIX shell.
 *    No agent daemons, no listening ports, no new attack surface inbound.
 *
 *  - Per-host allowlists of tools. `ramcp fleet add --tools shell,fs` is the
 *    whole security model: a host that was never granted a tool group
 *    refuses it with a clear error. Local-only tools (schedule, policy
 *    management, ops) ignore `host` entirely.
 *
 *  - File transfer for fs tools is piped over stdin via base64, so writes
 *    don't touch the remote disk with temp files (which would race, leak
 *    into other users' listings, or fail on full filesystems).
 *
 *  - SSH_BIN env override exists for tests (fake ssh) and for Windows hosts
 *    that want a specific OpenSSH path.
 */

export interface FleetHost {
  name: string;
  host: string;             // user@hostname
  port?: number;
  tools: string[];          // tool groups this host may serve: shell, fs, services, packages, logs
  note?: string;
  added: string;
}

/** Tool group → fleet capability check. Local-only groups have no remote path. */
export const FLEET_CAPABILITIES = ['shell', 'fs', 'services', 'packages', 'logs'] as const;

export function isFleetCapability(g: string): boolean {
  return (FLEET_CAPABILITIES as readonly string[]).includes(g);
}

export function sshBin(): string {
  return process.env.SSH_BIN || 'ssh';
}

export interface SshOpts {
  timeoutMs?: number;
  stdin?: string;           // piped to the remote command's stdin
}

/** Run one command over SSH. Throws on non-zero exit with combined output. */
export async function sshRun(
  host: string,
  port: number | undefined,
  command: string,
  opts: SshOpts = {},
): Promise<{ stdout: string; stderr: string }> {
  const args = [
    // -T: no pty (we want clean pipes), BatchMode: never prompt — a hung
    // password prompt inside an AI tool call is a deadlock.
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=15',
  ];
  if (port) args.push('-p', String(port));
  args.push(host, '--', command);

  // NOTE: promisify(execFile) does not forward the `input` option (a known
  // footgun — the child's stdin never closes and the call hangs to timeout).
  // stdin piping is therefore done by hand: write, then end.
  if (opts.stdin !== undefined) {
    return await new Promise((resolve, reject) => {
      const child = spawn(sshBin(), args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`ssh timed out after ${Math.round((opts.timeoutMs ?? 120_000) / 1000)}s`));
      }, opts.timeoutMs ?? 120_000);
      child.stdout.on('data', c => { stdout += c; });
      child.stderr.on('data', c => { stderr += c; });
      child.on('error', e => { clearTimeout(timer); reject(e); });
      child.on('close', code => {
        clearTimeout(timer);
        if (code === 0) resolve({ stdout, stderr });
        else reject(Object.assign(new Error(`ssh exited with ${code}`), { stdout, stderr }));
      });
      child.stdin.write(opts.stdin!);
      child.stdin.end();
    });
  }

  const { stdout, stderr } = await exec(sshBin(), args, {
    timeout: opts.timeoutMs ?? 120_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return { stdout, stderr };
}

/** Exit status of a probe command; 0 = reachable. */
export async function fleetProbe(host: FleetHost): Promise<{ ok: boolean; detail: string }> {
  try {
    const { stdout } = await sshRun(host.host, host.port, 'echo ramcp-ok', { timeoutMs: 15_000 });
    return { ok: stdout.includes('ramcp-ok'), detail: stdout.trim() };
  } catch (e: any) {
    return { ok: false, detail: (e.stderr || e.stdout || e.message || '').split('\n')[0].slice(0, 120) };
  }
}

// ---------------------------------------------------------------------------
// Command builders — single source of truth for what runs remotely.
// All of these are invoked via `ssh … -- command`, so each one gets ONE
// shell string. Keep them quoting-tight: paths arrive validated from the
// tool schema (zod), but we still quote everything with double quotes.
// ---------------------------------------------------------------------------

const q = (s: string) => `"${s.replace(/(["\\$`])/g, '\\$1')}"`;
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

/** shell group */
export function buildRunCommand(command: string, cwd?: string, timeoutMs = 120_000): string {
  const secs = Math.min(Math.round(timeoutMs / 1000), 600);
  const inner = cwd
    ? `cd ${q(cwd)} 2>/dev/null && ${command}`
    : command;
  return `timeout ${secs} sh -c ${q(inner)} 2>&1`;
}

/** fs group */
export function buildReadCommand(path: string): string {
  return `[ -f ${q(path)} ] && base64 ${q(path)}`;
}

export function buildWriteCommand(path: string, content: string, mkdir: boolean): string {
  const pre = mkdir ? `mkdir -p ${q(path.replace(/\/[^/]*$/, ''))} && ` : '';
  // stdin carries the base64; the command decodes it. No temp files.
  return `${pre}base64 -d > ${q(path)}`;
}

export function buildDeleteCommand(path: string): string {
  return `rm -rf ${q(path)}`;
}

export function buildListCommand(path: string): string {
  // trailing / on dirs; -F suffixes symlinks with @
  return `ls -1F ${q(path)} 2>&1 | head -2000`;
}

export function buildFileInfoCommand(path: string): string {
  return `stat ${q(path)} 2>&1`;
}

export function buildTailCommand(path: string, lines: number): string {
  return `tail -n ${Math.max(1, Math.min(lines, 1000))} ${q(path)} 2>&1`;
}

export function buildSearchCommand(path: string, pattern: string, maxResults: number): string {
  // pattern is ERE; validated as a string by zod, quoted single to avoid interpolation
  const p = pattern.replace(/'/g, `'\\''`);
  return `grep -rEn ${q(p)} ${q(path)} 2>/dev/null | head -${Math.min(maxResults, 200)} || echo "(no matches)"`;
}

/** services group */
export function buildServiceStatusCommand(unit: string): string {
  return `systemctl is-active ${q(unit)}; systemctl is-enabled ${q(unit)} 2>&1`;
}

export function buildServiceActionCommand(unit: string, action: string): string {
  return `systemctl ${q(action)} ${q(unit)} 2>&1`;
}

/** packages group */
export function buildPackageListCommand(filter?: string): string {
  const base = `dpkg-query -W -f '\"\${Package}\\t\${Version}\\n\"' 2>/dev/null`;
  if (!filter) return base;
  return `${base} | grep -i ${q(filter)} || true`;
}

/** logs group */
export function buildJournalCommand(unit: string, lines: number): string {
  return `journalctl -u ${q(unit)} -n ${Math.min(lines, 500)} --no-pager -o short-iso 2>&1 | tail -${Math.min(lines, 500)}`;
}

// ---------------------------------------------------------------------------
// Host lookup + capability gate
// ---------------------------------------------------------------------------

export class FleetError extends Error {
  constructor(msg: string) { super(msg); this.name = 'FleetError'; }
}

export function findHost(hosts: FleetHost[], name: string): FleetHost {
  const h = hosts.find(h => h.name === name);
  if (!h) throw new FleetError(`Unknown fleet host "${name}". Known: ${hosts.map(h => h.name).join(', ') || '(none)'}`);
  return h;
}

/** Throws unless the host was granted the tool group at `ramcp fleet add` time. */
export function assertCapability(hosts: FleetHost[], name: string, group: string): FleetHost {
  const h = findHost(hosts, name);
  if (!h.tools.includes(group)) {
    throw new FleetError(`Host "${name}" does not allow the ${group} tool group (allowed: ${h.tools.join(', ') || 'none'}). Grant it with: ramcp fleet edit ${name} --tools ${group}`);
  }
  return h;
}
