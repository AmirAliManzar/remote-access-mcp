import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { startQuickTunnel, type TunnelHandle } from './tunnel.js';
import { which } from './platform.js';

export type TunnelProviderName = 'cloudflare' | 'pinggy' | 'localhostrun' | 'nport';

export const TUNNEL_PROVIDERS: TunnelProviderName[] = ['cloudflare', 'pinggy', 'localhostrun', 'nport'];

export interface TunnelProviderOptions {
  port: number;
  host?: string;
  timeoutMs?: number;
  log?: (msg: string) => void;
  expectedVersion?: string;
  healthTimeoutMs?: number;
  debug?: boolean;
}

export interface TunnelHealth {
  healthy: boolean;
  status?: number;
  reason?: string;
}

/** Verify that a public URL is actually serving this MCP gateway, not merely an HTTP edge/provider error. */
export async function verifyTunnelHealth(url: string, expectedVersion?: string, timeoutMs = 5_000): Promise<TunnelHealth> {
  try {
    const response = await fetch(`${url.replace(/\/$/, '')}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
    });
    const body = await response.text();
    if (!response.ok) return { healthy: false, status: response.status, reason: `HTTP ${response.status}: ${body.slice(0, 160)}` };
    let payload: any;
    try { payload = JSON.parse(body); } catch { return { healthy: false, status: response.status, reason: 'health endpoint returned non-JSON content' }; }
    if (payload?.status !== 'ok' || payload?.service !== 'remote-access-mcp') {
      return { healthy: false, status: response.status, reason: 'health response is not from Remote Access MCP' };
    }
    if (expectedVersion && payload.version !== expectedVersion) {
      return { healthy: false, status: response.status, reason: `version mismatch: expected ${expectedVersion}, got ${payload.version ?? 'unknown'}` };
    }
    return { healthy: true, status: response.status };
  } catch (e: any) {
    return { healthy: false, reason: e?.message || String(e) };
  }
}

const URL_PATTERNS: Record<TunnelProviderName, RegExp> = {
  pinggy: /https:\/\/[^\s"'<>]+\.(?:free\.pinggy\.net|pinggy-free\.link)/i,
  localhostrun: /https:\/\/[^\s"'<>]+\.lhr\.life/i,
  cloudflare: /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i,
  nport: /https:\/\/[a-z0-9-]+\.(?:nport\.link|nport\.online)/i,
};

function startSshTunnel(name: TunnelProviderName, opts: TunnelProviderOptions, args: string[]): Promise<TunnelHandle> {
  const ssh = which('ssh');
  if (!ssh) throw new Error(`${name}: ssh is not installed`);
  const sshArgs = [
    ...(name === 'localhostrun' ? ['-tt'] : ['-T']),
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=5',
    '-o', 'ServerAliveCountMax=6',
    '-o', 'TCPKeepAlive=yes',
    ...args.filter((arg) => !['-o', 'StrictHostKeyChecking=accept-new', '-o', 'ExitOnForwardFailure=yes'].includes(arg)),
  ];
  // localhost.run exposes the public URL through the remote shell, so stdin
  // must stay open. On Windows, detach the SSH process from the console and
  // unref it so terminal/console-handle teardown cannot close the tunnel.
  const debugDir = opts.debug ? mkdtempSync(path.join(tmpdir(), 'ramcp-tunnel-')) : null;
  const debugOut = debugDir ? createWriteStream(path.join(debugDir, `${name}.out.log`), { flags: 'a' }) : null;
  const debugErr = debugDir ? createWriteStream(path.join(debugDir, `${name}.err.log`), { flags: 'a' }) : null;
  const child = spawn(ssh, sshArgs, {
    // localhost.run's free SSH session is an interactive remote shell carrying
    // the reverse-forward. Force a PTY for localhost.run so the Windows OpenSSH
    // child has the same interactive SSH session shape as the documented CLI
    // usage. Keep stdin attached to the user's console; stdout/stderr stay
    // piped for URL parsing and diagnostics.
    stdio: [process.platform === 'win32' ? 'inherit' : 'pipe', 'pipe', 'pipe'],
    windowsHide: false,
  });
  if (debugOut) child.stdout?.pipe(debugOut);
  if (debugErr) child.stderr?.pipe(debugErr);
  if (opts.debug) opts.log?.(`${name}: debug pid=${child.pid ?? 'unknown'} platform=${process.platform} ssh=${ssh} args=${sshArgs.join(' ')}`);
  const timeoutMs = opts.timeoutMs ?? 45_000;
  const log = opts.log || (() => {});
  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = '';
    const cleanup = () => {
      try { child.stdin?.end(); } catch {}
      try { child.kill(); } catch {}
      try { debugOut?.end(); debugErr?.end(); } catch {}
      if (debugDir) opts.log?.(`${name}: debug logs=${debugDir}`);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true; cleanup();
      reject(new Error(`${name} did not report a public URL within ${Math.round(timeoutMs / 1000)}s.\n${buffer.slice(-800)}`));
    }, timeoutMs);
    const scan = (chunk: Buffer) => {
      buffer += chunk.toString();
      const m = buffer.match(URL_PATTERNS[name]);
      if (!m || settled) return;
      settled = true; clearTimeout(timer);
      const url = m[0].replace(/[.,;)]+$/, '');
      log(`${name}: ${url}`);
      const handle: TunnelHandle = { url, child, stop: cleanup, provider: name };
      const healthDeadline = Date.now() + (opts.healthTimeoutMs ?? 20_000);
      const verify = async (): Promise<void> => {
        if (!opts.expectedVersion) {
          resolve(handle);
          return;
        }
        let health = await verifyTunnelHealth(url, opts.expectedVersion, 4_000);
        while (!health.healthy && Date.now() < healthDeadline) {
          await new Promise((r) => setTimeout(r, 1_500));
          if (child.exitCode !== null) break;
          health = await verifyTunnelHealth(url, opts.expectedVersion, 4_000);
        }
        if (health.healthy) {
          log(`${name}: public endpoint verified`);
          resolve(handle);
          return;
        }
        cleanup();
        reject(new Error(`${name} public endpoint failed health verification: ${health.reason || 'unknown error'}`));
      };
      void verify().catch((error) => {
        cleanup();
        reject(error);
      });
    };
    child.stdout?.on('data', (chunk) => { if (opts.debug) opts.log?.(`${name}: stdout ${chunk.toString().trim().slice(0, 400)}`); scan(chunk); });
    child.stderr?.on('data', (chunk) => { if (opts.debug) opts.log?.(`${name}: stderr ${chunk.toString().trim().slice(0, 400)}`); scan(chunk); });
    child.on('error', (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } });
    child.on('exit', (code) => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error(`${name} exited with code ${code}\n${buffer.slice(-800)}`)); } });
  });
}

function startProcessTunnel(name: TunnelProviderName, opts: TunnelProviderOptions, command: string, args: string[]): Promise<TunnelHandle> {
  const isWindows = process.platform === 'win32';
  const spawnCommand = isWindows ? process.env.ComSpec || 'cmd.exe' : command;
  const spawnArgs = isWindows
    ? ['/d', '/s', '/c', [command, ...args].map((value) => /[\s&()^]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value).join(' ')]
    : args;
  const child = spawn(spawnCommand, spawnArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: isWindows,
  });
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const log = opts.log || (() => {});
  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = '';
    const cleanup = () => { try { child.kill(); } catch {} };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`${name} did not report a public URL within ${Math.round(timeoutMs / 1000)}s.\n${buffer.slice(-800)}`));
    }, timeoutMs);
    const scan = (chunk: Buffer) => {
      buffer += chunk.toString();
      const m = buffer.match(URL_PATTERNS[name]);
      if (!m || settled) return;
      settled = true;
      clearTimeout(timer);
      const url = m[0].replace(/[.,;)]+$/, '');
      log(`${name}: ${url}`);
      const handle: TunnelHandle = { url, child, stop: cleanup, provider: name };
      const healthDeadline = Date.now() + (opts.healthTimeoutMs ?? 20_000);
      const verify = async (): Promise<void> => {
        if (!opts.expectedVersion) { resolve(handle); return; }
        let health = await verifyTunnelHealth(url, opts.expectedVersion, 4_000);
        while (!health.healthy && Date.now() < healthDeadline) {
          await new Promise((r) => setTimeout(r, 1_500));
          if (child.exitCode !== null) break;
          health = await verifyTunnelHealth(url, opts.expectedVersion, 4_000);
        }
        if (health.healthy) {
          log(`${name}: public endpoint verified`);
          resolve(handle);
          return;
        }
        cleanup();
        reject(new Error(`${name} public endpoint failed health verification: ${health.reason || 'unknown error'}`));
      };
      void verify().catch((error) => { cleanup(); reject(error); });
    };
    child.stdout?.on('data', scan);
    child.stderr?.on('data', scan);
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`${name} exited with code ${code}\n${buffer.slice(-800)}`));
    });
  });
}

export async function startTunnelProvider(name: TunnelProviderName, opts: TunnelProviderOptions): Promise<TunnelHandle> {
  const host = opts.host || '127.0.0.1';
  if (name === 'cloudflare') {
    const handle = await startQuickTunnel(opts);
    if (!opts.expectedVersion) return handle;
    const deadline = Date.now() + (opts.healthTimeoutMs ?? 20_000);
    let health = await verifyTunnelHealth(handle.url, opts.expectedVersion, 4_000);
    while (!health.healthy && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1_500));
      if (handle.child.exitCode !== null) break;
      health = await verifyTunnelHealth(handle.url, opts.expectedVersion, 4_000);
    }
    if (!health.healthy) {
      handle.stop();
      throw new Error(`cloudflare public endpoint failed health verification: ${health.reason || 'unknown error'}`);
    }
    opts.log?.('cloudflare: public endpoint verified');
    return handle;
  }
  if (name === 'pinggy') {
    return startSshTunnel(name, opts, ['-p', '443', '-R', `0:${host}:${opts.port}`, 'a.pinggy.io']);
  }
  if (name === 'localhostrun') {
    return startSshTunnel(name, opts, ['-R', `80:${host}:${opts.port}`, 'nokey@localhost.run']);
  }

  const majorNode = Number.parseInt(process.versions.node.split('.')[0], 10);
  if (majorNode < 20) throw new Error('nport requires Node.js 20 or newer');
  const npx = which(process.platform === 'win32' ? 'npx.cmd' : 'npx');
  if (!npx) throw new Error('nport: npx is not installed');
  const subdomain = `ramcp-${randomBytes(5).toString('hex')}`;
  return startProcessTunnel(name, opts, npx, ['--yes', 'nport', String(opts.port), '-s', subdomain, '-l', 'en']);
}

export async function startTunnelAuto(opts: TunnelProviderOptions, preferred?: TunnelProviderName): Promise<TunnelHandle> {
  const failures: string[] = [];
  const order = preferred ? [preferred, ...TUNNEL_PROVIDERS.filter(p => p !== preferred)] : TUNNEL_PROVIDERS;
  for (const provider of order) {
    try { return await startTunnelProvider(provider, opts); }
    catch (e: any) { failures.push(`${provider}: ${e?.message || e}`); }
  }
  throw new Error(`no tunnel provider succeeded\n${failures.join('\n')}`);
}
