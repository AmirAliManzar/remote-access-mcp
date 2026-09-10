import net from 'node:net';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Never consume ports normally owned by public web/control-panel services.
export const RESERVED_PUBLIC_PORTS = new Set([
  20, 21, 22, 23, 25, 53, 80, 110, 111, 135, 139, 143, 389, 443, 445,
  465, 587, 993, 995, 1433, 1521, 2049, 2375, 2376, 3000, 3306, 3389,
  5000, 5432, 5672, 5900, 6379, 6443, 8000, 8008, 8080, 8081, 8443,
  8888, 9000, 9090, 9200, 11211, 15672, 2082, 2083, 2086, 2087, 2095,
  2096,
]);

const MIN_PORT = 49152;
const MAX_PORT = 65535;

export function isReservedPublicPort(port: number): boolean {
  return RESERVED_PUBLIC_PORTS.has(port) || port < MIN_PORT || port > MAX_PORT;
}

export async function isPortFree(port: number, host = '0.0.0.0'): Promise<boolean> {
  if (isReservedPublicPort(port)) return false;
  return await new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen({ port, host }, () => server.close(() => resolve(true)));
  });
}

export async function chooseDirectPort(preferred?: number): Promise<number> {
  if (preferred && await isPortFree(preferred)) return preferred;
  for (let i = 0; i < 80; i++) {
    const port = MIN_PORT + Math.floor(Math.random() * (MAX_PORT - MIN_PORT + 1));
    if (await isPortFree(port)) return port;
  }
  throw new Error('could not find a free high direct HTTP port');
}

export function getPublicIPv4(): string | null {
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal && !isPrivateIPv4(entry.address)) return entry.address;
    }
  }
  return null;
}

function isPrivateIPv4(ip: string): boolean {
  const p = ip.split('.').map(Number);
  return p.length === 4 && (
    p[0] === 10 || p[0] === 127 || (p[0] === 192 && p[1] === 168) ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 169 && p[1] === 254)
  );
}

async function ufw(args: string[]): Promise<void> {
  try {
    await execFileAsync('ufw', args, { timeout: 15_000 });
  } catch (e: any) {
    const msg = String(e?.stderr || e?.message || e);
    if (/command not found|ENOENT/i.test(msg)) return; // UFW not installed; caller can still use an external firewall.
    throw new Error(`ufw ${args.join(' ')} failed: ${msg.slice(-500)}`);
  }
}

export async function allowDirectPort(port: number): Promise<void> {
  if (isReservedPublicPort(port)) throw new Error(`refusing firewall rule for reserved public port ${port}`);
  await ufw(['allow', `${port}/tcp`, 'comment', 'remote-access-mcp-direct']);
}

export async function denyDirectPort(port: number): Promise<void> {
  if (isReservedPublicPort(port)) return;
  try { await ufw(['delete', 'allow', `${port}/tcp`]); } catch { /* best effort cleanup */ }
}
