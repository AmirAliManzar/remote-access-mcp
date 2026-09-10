import { spawn, type ChildProcess } from 'node:child_process';
import { startQuickTunnel, type TunnelHandle } from './tunnel.js';
import { which } from './platform.js';

export type TunnelProviderName = 'cloudflare' | 'pinggy' | 'localhostrun';

export const TUNNEL_PROVIDERS: TunnelProviderName[] = ['cloudflare', 'pinggy', 'localhostrun'];

export interface TunnelProviderOptions {
  port: number;
  host?: string;
  timeoutMs?: number;
  log?: (msg: string) => void;
}

const URL_PATTERNS: Record<TunnelProviderName, RegExp> = {
  pinggy: /https:\/\/[^\s"'<>]+\.(?:free\.pinggy\.net|pinggy-free\.link)/i,
  localhostrun: /https:\/\/[^\s"'<>]+\.lhr\.life/i,
  cloudflare: /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i,
};

function startSshTunnel(name: TunnelProviderName, opts: TunnelProviderOptions, args: string[]): Promise<TunnelHandle> {
  const ssh = which('ssh');
  if (!ssh) throw new Error(`${name}: ssh is not installed`);
  const child = spawn(ssh, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const timeoutMs = opts.timeoutMs ?? 45_000;
  const log = opts.log || (() => {});
  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = '';
    const cleanup = () => { try { child.kill(); } catch {} };
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
      log(`${name}: ${m[0]}`);
      resolve({ url: m[0].replace(/[.,;)]+$/, ''), child, stop: cleanup, provider: name });
    };
    child.stdout?.on('data', scan); child.stderr?.on('data', scan);
    child.on('error', (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } });
    child.on('exit', (code) => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error(`${name} exited with code ${code}\n${buffer.slice(-800)}`)); } });
  });
}

export async function startTunnelProvider(name: TunnelProviderName, opts: TunnelProviderOptions): Promise<TunnelHandle> {
  const host = opts.host || '127.0.0.1';
  if (name === 'cloudflare') return startQuickTunnel(opts);
  if (name === 'pinggy') {
    return startSshTunnel(name, opts, ['-o', 'StrictHostKeyChecking=accept-new', '-o', 'ExitOnForwardFailure=yes', '-p', '443', '-R', `0:${host}:${opts.port}`, 'a.pinggy.io']);
  }
  return startSshTunnel(name, opts, ['-o', 'StrictHostKeyChecking=accept-new', '-o', 'ExitOnForwardFailure=yes', '-R', `80:${host}:${opts.port}`, 'nokey@localhost.run']);
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
