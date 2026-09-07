import { ContextEngine } from '../dist/core/context-engine.js';

const iterations = 1000;
const pretty = JSON.stringify({ host: 'example', items: Array.from({ length: 50 }, (_, i) => ({ id: i, status: 'ok', repeated: 'value' })) }, null, 2);
const result = { content: [{ type: 'text', text: pretty }] };
const engine = new ContextEngine('benchmark-token', { mode: 'balanced', maxTextChars: 32_000 });

for (let i = 0; i < 50; i++) engine.compactResult(result);
const started = performance.now();
let outputBytes = 0;
for (let i = 0; i < iterations; i++) outputBytes += Buffer.byteLength(engine.compactResult(result).content[0].text);
const elapsed = performance.now() - started;
const inputBytes = Buffer.byteLength(pretty) * iterations;
console.log(JSON.stringify({ iterations, inputBytes, outputBytes, savedBytes: inputBytes - outputBytes, savedPercent: Number(((1 - outputBytes / inputBytes) * 100).toFixed(2)), totalMs: Number(elapsed.toFixed(3)), avgMs: Number((elapsed / iterations).toFixed(4)) }, null, 2));
