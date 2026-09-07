import { performance } from 'node:perf_hooks';
import { analyzeSecurity } from '../dist/core/security-analysis.js';
import { decideAutonomy } from '../dist/core/autonomy.js';

const samples = 200;
const times = [];
let allowed = 0;
for (let i = 0; i < samples; i++) {
  const t = performance.now();
  const report = analyzeSecurity({ scopes: ['security','filesystem','diagnostics'], readOnly: true, shellEnabled: false, allowedPaths: ['/tmp'], deniedPaths: [] });
  const decision = decideAutonomy('autonomous', i % 2 ? 'low' : 'high', { enabled: true, allowAutonomousHighRisk: true });
  if (decision === 'allow') allowed++;
  if (report.score < 0) throw new Error('invalid security score');
  times.push(performance.now() - t);
}
times.sort((a,b) => a-b);
const p = q => times[Math.floor((times.length - 1) * q)];
console.log(JSON.stringify({ samples, security_and_autonomy_checks: samples, p50_ms: p(.5), p95_ms: p(.95), avg_ms: times.reduce((a,b)=>a+b,0)/times.length, allowed }, null, 2));
