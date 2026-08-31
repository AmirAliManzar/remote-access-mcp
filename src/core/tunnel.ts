import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { platform, isWindows, isMac, which, dataDir } from './platform.js';

/**
 * Public URL via Cloudflare Quick Tunnel — no account, no DNS, no port forward.
 *
 * Why cloudflared: it is the only widely-available tunnel that hands out a
 * working https URL with zero signup, works on all three platforms, and does
 * not inject an interstitial page (ngrok's free tier does, which breaks MCP
 * clients that expect raw JSON).
 *
 * The binary is downloaded once into the user's data dir — no admin rights,
 * no package manager, no PATH surgery.
 */

const CF_BASE = 'https://github.com/cloudflare/cloudflared/releases/latest/download';

function assetName(): string {
  const arch = process.arch; // 'x64' | 'arm64' | ...
  switch (platform()) {
    case 'win32':
      return arch === 'arm64' ? 'cloudflared-windows-arm64.exe' : 'cloudflared-windows-amd64.exe';
    case 'darwin':
      // Cloudflare ships macOS as a .tgz; arm64 build exists since 2023.
      return arch === 'arm64' ? 'cloudflared-darwin-arm64.tgz' : 'cloudflared-darwin-amd64.tgz';
    default:
      if (arch === 'arm64') return 'cloudflared-linux-arm64';
      if (arch === 'arm') return 'cloudflared-linux-arm';
      return 'cloudflared-linux-amd64';
  }
}

export function tunnelBinPath(): string {
  const dir = path.join(dataDir(), 'bin');
  return path.join(dir, isWindows() ? 'cloudflared.exe' : 'cloudflared');
}

/** Prefer a system cloudflared when present; else our downloaded copy. */
export function resolveCloudflared(): string | null {
  const system = which('cloudflared');
  if (system) return system;
  const local = tunnelBinPath();
  return fs.existsSync(local) ? local : null;
}

export async function ensureCloudflared(log: (msg: string) => void = () => {}): Promise<string> {
  const existing = resolveCloudflared();
  if (existing) return existing;

  const dest = tunnelBinPath();
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const asset = assetName();
  const url = `${CF_BASE}/${asset}`;
  log(`downloading cloudflared (${asset})…`);

  const resp = await fetch(url, { redirect: 'follow' });
  if (!resp.ok || !resp.body) throw new Error(`download failed: HTTP ${resp.status} ${url}`);

  if (asset.endsWith('.tgz')) {
    // macOS: extract the single binary out of the tarball.
    const tmp = path.join(os.tmpdir(), `cloudflared-${Date.now()}.tgz`);
    await fsp.writeFile(tmp, Buffer.from(await resp.arrayBuffer()));
    const { execFileSync } = await import('node:child_process');
    execFileSync('tar', ['-xzf', tmp, '-C', path.dirname(dest)], { stdio: 'ignore' });
    await fsp.rm(tmp, { force: true });
    // Tarball contains "cloudflared"; ensure the expected name/mode.
    const extracted = path.join(path.dirname(dest), 'cloudflared');
    if (extracted !== dest && fs.existsSync(extracted)) await fsp.rename(extracted, dest);
  } else {
    const out = fs.createWriteStream(dest);
    await pipeline(resp.body as unknown as NodeJS.ReadableStream, out);
  }

  if (!isWindows()) await fsp.chmod(dest, 0o755);
  log(`cloudflared ready: ${dest}`);
  return dest;
}

export interface TunnelHandle {
  url: string;
  child: ChildProcess;
  stop(): void;
}

/**
 * Start a Quick Tunnel to a local port and resolve once Cloudflare prints
 * the public hostname. Rejects on timeout so the CLI can report clearly
 * instead of hanging.
 */
export async function startQuickTunnel(opts: {
  port: number;
  host?: string;
  bin?: string;
  timeoutMs?: number;
  log?: (msg: string) => void;
}): Promise<TunnelHandle> {
  const { port, host = '127.0.0.1', timeoutMs = 45_000 } = opts;
  const log = opts.log || (() => {});
  const bin = opts.bin || await ensureCloudflared(log);

  const child = spawn(bin, [
    'tunnel',
    '--no-autoupdate',
    '--url', `http://${host}:${port}`,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  return await new Promise<TunnelHandle>((resolve, reject) => {
    let settled = false;
    let buffer = '';

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`tunnel did not report a URL within ${Math.round(timeoutMs / 1000)}s.\n${buffer.slice(-800)}`));
    }, timeoutMs);

    const scan = (chunk: Buffer) => {
      const text = chunk.toString();
      buffer += text;
      // cloudflared prints e.g. https://random-words-1234.trycloudflare.com
      const m = buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({
          url: m[0],
          child,
          stop: () => { try { child.kill(); } catch { /* already gone */ } },
        });
      }
    };

    child.stdout?.on('data', scan);
    child.stderr?.on('data', scan); // cloudflared logs the URL on stderr
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
      reject(new Error(`cloudflared exited with code ${code}\n${buffer.slice(-800)}`));
    });
  });
}
