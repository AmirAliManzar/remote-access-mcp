import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ramcp-automation-bench-'));
process.env.XDG_CONFIG_HOME = temp;
try {
  const { createRule, dispatchAutomationEvent, clearAutomationRulesForTests } = await import(path.join(root, 'dist', 'core', 'automation-engine.js'));
  for (let i = 0; i < 200; i++) createRule({ name: `bench-${i}`, tokenFingerprint: 'bench', enabled: true, trigger: { type: 'tool', tool: 'bench' }, conditions: [{ field: 'kind', op: 'equals', value: 'x' }], actions: [{ tool: 'safe', args: {} }] });
  const samples = [];
  for (let i = 0; i < 100; i++) {
    const t = performance.now();
    await dispatchAutomationEvent({ type: 'tool.success', tool: 'bench', data: { kind: 'x' }, tokenFingerprint: 'bench', ts: Date.now() }, async () => {});
    samples.push(performance.now() - t);
  }
  samples.sort((a,b)=>a-b);
  const pct = p => samples[Math.min(samples.length - 1, Math.floor(samples.length * p))];
  console.log(JSON.stringify({ rules: 200, samples: 100, p50_ms: pct(.5), p95_ms: pct(.95), avg_ms: samples.reduce((a,b)=>a+b,0)/samples.length, rss_mb: process.memoryUsage().rss/1024/1024 }, null, 2));
  clearAutomationRulesForTests();
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
