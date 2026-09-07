import { createRequire } from 'node:module';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../core/context.js';
import { assertAllowed, assertToolPermitted } from '../core/policy.js';
import net from 'node:net';

const require = createRequire(import.meta.url);
const MAX_TEXT = 120_000;

function blockedHost(hostname: string): boolean {
  if (net.isIPv4(hostname)) {
    const [a, b] = hostname.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (net.isIPv6(hostname)) {
    const h = hostname.toLowerCase();
    return h === '::' || h === '::1' || h.startsWith('fe80') || h.startsWith('fc') || h.startsWith('fd');
  }
  return ['localhost', 'metadata.google.internal', 'instance-data'].some(n => hostname === n || hostname.endsWith(`.${n}`));
}

function assertPublicUrl(raw: string): URL {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP(S) URLs are allowed');
  if (blockedHost(url.hostname)) throw new Error(`Refusing browser access to internal/private host ${url.hostname}`);
  return url;
}

function playwright(): any {
  try { return require('playwright'); } catch {
    try { return require('playwright-core'); } catch { throw new Error('Browser integration is unavailable: install Playwright or playwright-core on the host'); }
  }
}

async function withBrowser<T>(fn: (page: any) => Promise<T>): Promise<T> {
  const pw = playwright();
  const browser = await pw.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ javaScriptEnabled: true });
    page.setDefaultTimeout(20_000);
    return await fn(page);
  } finally { await browser.close(); }
}

export function registerBrowserTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool('browser_open', {
    description: 'Open a public web page in a headless browser and return its title, URL, and visible text. SSRF-guarded.',
    inputSchema: { url: z.string().url(), wait_ms: z.number().int().min(0).max(10_000).optional().default(500) },
  }, async ({ url, wait_ms }) => {
    assertToolPermitted({ tool: 'browser_open', scopes: ctx.token.scopes, readOnly: ctx.readOnly });
    const target = assertPublicUrl(url);
    return { content: [{ type: 'text', text: await withBrowser(async page => {
      await page.goto(target.toString(), { waitUntil: 'domcontentloaded' });
      if (wait_ms) await page.waitForTimeout(wait_ms);
      const title = await page.title();
      const text = (await page.locator('body').innerText()).slice(0, MAX_TEXT);
      return `url: ${page.url()}\ntitle: ${title}\n\n${text}`;
    }) }] };
  });

  server.registerTool('browser_extract', {
    description: 'Extract structured links and metadata from a public page using a headless browser.',
    inputSchema: { url: z.string().url(), max_links: z.number().int().min(1).max(100).optional().default(30) },
  }, async ({ url, max_links }) => {
    assertToolPermitted({ tool: 'browser_extract', scopes: ctx.token.scopes, readOnly: ctx.readOnly });
    const target = assertPublicUrl(url);
    return { content: [{ type: 'text', text: await withBrowser(async page => {
      await page.goto(target.toString(), { waitUntil: 'domcontentloaded' });
      const data = await page.evaluate((limit: number) => {
        const doc = (globalThis as any).document;
        return {
          title: doc.title,
          description: doc.querySelector('meta[name="description"]')?.getAttribute('content') || '',
          links: Array.from(doc.querySelectorAll('a[href]') as any[]).slice(0, limit).map((a: any) => ({ text: (a.textContent || '').trim().slice(0, 200), href: a.href })),
        };
      }, max_links);
      return JSON.stringify(data, null, 2);
    }) }] };
  });

  server.registerTool('browser_screenshot', {
    description: 'Capture a screenshot of a public web page to a policy-allowed local path.',
    inputSchema: { url: z.string().url(), output_path: z.string().min(1).max(1000), full_page: z.boolean().optional().default(false) },
  }, async ({ url, output_path, full_page }) => {
    assertToolPermitted({ tool: 'browser_screenshot', scopes: ctx.token.scopes, readOnly: ctx.readOnly });
    if (ctx.readOnly) throw new Error('browser_screenshot requires mutation permission because it writes a file');
    assertAllowed({ allowed_paths: ctx.token.allowed_paths, denied_paths: ctx.token.denied_paths, shell_enabled: ctx.token.shell_enabled, read_only: ctx.readOnly }, output_path);
    const target = assertPublicUrl(url);
    await withBrowser(async page => { await page.goto(target.toString(), { waitUntil: 'networkidle' }); await page.screenshot({ path: output_path, fullPage: full_page }); });
    return { content: [{ type: 'text', text: `Screenshot written to ${output_path}` }] };
  });
}
