import { describe, expect, it } from 'vitest';
import { registerBrowserTools } from '../src/tools/browser.js';
import { registerInfrastructureTools } from '../src/tools/infrastructure.js';

function harness(register: (server: any, ctx: any) => void, overrides: any = {}) {
  const handlers = new Map<string, (args: any) => Promise<any>>();
  const server = { registerTool(name: string, _config: any, handler: any) { handlers.set(name, handler); } };
  const ctx = {
    cfg: {}, token: { scopes: ['browser', 'infrastructure'], allowed_paths: ['/tmp'], denied_paths: [], shell_enabled: false },
    readOnly: false, persist() {}, audit() {}, ...overrides,
  };
  register(server, ctx);
  return handlers;
}

describe('Phase 5 browser + infrastructure tools', () => {
  it('registers the complete ecosystem surface', () => {
    const h = new Map<string, any>();
    for (const register of [registerBrowserTools, registerInfrastructureTools]) {
      const x = harness(register);
      for (const [k, v] of x) h.set(k, v);
    }
    expect([...h.keys()]).toEqual(expect.arrayContaining([
      'browser_open', 'browser_extract', 'browser_screenshot',
      'infra_probe', 'docker_ps', 'docker_inspect', 'docker_logs', 'docker_action',
      'kubernetes_get', 'kubernetes_describe', 'kubernetes_logs', 'cloudflare_status',
    ]));
  });

  it('blocks browser SSRF before attempting a browser launch', async () => {
    const h = harness(registerBrowserTools);
    await expect(h.get('browser_open')!({ url: 'http://127.0.0.1:8765' })).rejects.toThrow(/internal|private|Refusing/);
  });

  it('blocks screenshot writes outside the token sandbox', async () => {
    const h = harness(registerBrowserTools);
    await expect(h.get('browser_screenshot')!({ url: 'https://example.com', output_path: '/etc/ramcp-test.png' })).rejects.toThrow();
  });

  it('does not allow Docker mutation in read-only mode', async () => {
    const h = harness(registerInfrastructureTools, { readOnly: true });
    await expect(h.get('docker_action')!({ action: 'restart', container: 'safe-name' })).rejects.toThrow();
  });

  it('infra probe is non-destructive and reports missing tools instead of failing the request', async () => {
    const h = harness(registerInfrastructureTools);
    const result = await h.get('infra_probe')!({});
    expect(result.isError).not.toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body).toHaveProperty('docker');
    expect(body).toHaveProperty('kubectl');
    expect(body).toHaveProperty('cloudflared');
  });
});
