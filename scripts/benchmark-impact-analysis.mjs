import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { impactAnalysisForTest } from '../dist/tools/intelligence.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ramcp-impact-bench-'));
fs.mkdirSync(path.join(root, 'src'), { recursive: true });
for (let i = 0; i < 200; i += 1) {
  const dep = i ? `import { x } from './f${i - 1}.js';\n` : '';
  fs.writeFileSync(path.join(root, 'src', `f${i}.ts`), `${dep}export const x = ${i};\n`);
}
const samples = [];
for (let i = 0; i < 50; i += 1) {
  const start = performance.now();
  const result = await impactAnalysisForTest(root, ['src/f0.ts']);
  samples.push(performance.now() - start);
  if (result.impacted.length !== 200) throw new Error(`expected 200 impacted files, got ${result.impacted.length}`);
}
samples.sort((a, b) => a - b);
const percentile = p => samples[Math.floor((samples.length - 1) * p)];
console.log(JSON.stringify({ files: 200, runs: samples.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95), avgMs: samples.reduce((a, b) => a + b, 0) / samples.length }));
fs.rmSync(root, { recursive: true, force: true });
