import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataDir } from '../src/core/platform.js';
import { scopeOf } from '../src/core/policy.js';
import { registerPluginTools } from '../src/tools/plugins.js';

function harness() {
  const handlers = new Map<string, (args: any) => Promise<any>>();
  const server = { registerTool(name: string, _config: any, handler: any) { handlers.set(name, handler); } };
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'ramcp-plugin-test-'));
  const ctx = {
    cfg: {},
    token: { scopes: [], allowed_paths: [source], denied_paths: [], shell_enabled: false },
    readOnly: false,
    persist() {},
    audit() {},
  } as any;
  registerPluginTools(server as any, ctx);
  return { handlers, source };
}

beforeEach(() => fs.rmSync(path.join(dataDir(), 'plugins'), { recursive: true, force: true }));

describe('Phase 8 plugin isolation and lifecycle', () => {
  it('routes namespaced plugin tools through the plugins scope and read-only gate', () => {
    expect(scopeOf('plugin_demo__tool')).toBe('plugins');
  });

  it('rejects symbolic links during installation', async () => {
    const { handlers, source } = harness();
    fs.writeFileSync(path.join(source, 'index.js'), 'export async function register() {}\n');
    fs.writeFileSync(path.join(source, 'manifest.json'), JSON.stringify({ name: 'symlink-test', version: '1.0.0', entry: 'index.js' }));
    fs.symlinkSync('index.js', path.join(source, 'link.js'));
    const result = await handlers.get('plugin_install')!({ source });
    expect(result.isError).toBe(true);
    expect(fs.existsSync(path.join(dataDir(), 'plugins', 'symlink-test'))).toBe(false);
  });

  it('creates an integrity fingerprint on a valid local installation', async () => {
    const { handlers, source } = harness();
    fs.writeFileSync(path.join(source, 'index.js'), 'export async function register() {}\n');
    fs.writeFileSync(path.join(source, 'manifest.json'), JSON.stringify({ name: 'fingerprint-test', version: '1.0.0', entry: 'index.js' }));
    const result = await handlers.get('plugin_install')!({ source });
    expect(result.isError).not.toBe(true);
    const lock = JSON.parse(fs.readFileSync(path.join(dataDir(), 'plugins', 'plugins.lock.json'), 'utf8'));
    expect(lock['fingerprint-test'].sha256).toMatch(/^[a-f0-9]{64}$/);
  });
});
