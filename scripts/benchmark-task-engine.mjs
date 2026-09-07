import { performance } from 'node:perf_hooks';
import { TaskEngine } from '../dist/core/task-engine.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ramcp-task-bench-'));
const engine = new TaskEngine('benchmark-token', async () => ({ content: [{ type: 'text', text: 'ok' }] }), { dataDirectory: dir });
const samples = [];
for (let i = 0; i < 100; i++) {
  const start = performance.now();
  const row = engine.create({ goal: 'benchmark', autonomy: 'safe', actions: [
    { id: 'a', tool: 'system_info' },
    { id: 'b', tool: 'system_resource' },
    { id: 'c', tool: 'project_health_check', dependsOn: ['a', 'b'] },
  ] });
  await engine.run(row.id);
  samples.push(performance.now() - start);
}
samples.sort((a, b) => a - b);
const p50 = samples[Math.floor(samples.length * 0.5)];
const p95 = samples[Math.floor(samples.length * 0.95)];
const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
console.log(JSON.stringify({ runs: samples.length, p50Ms: p50, p95Ms: p95, avgMs: avg, rssMb: process.memoryUsage().rss / 1024 / 1024 }, null, 2));
fs.rmSync(dir, { recursive: true, force: true });
