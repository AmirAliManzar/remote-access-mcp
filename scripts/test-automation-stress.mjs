import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ramcp-automation-'));
const env = { ...process.env, XDG_CONFIG_HOME: temp };
const engine = path.join(root, 'dist', 'core', 'automation-engine.js');
const run = (code) => new Promise((resolve, reject) => {
  const p = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; p.stderr.on('data', d => { stderr += d; });
  p.on('close', code => code === 0 ? resolve() : reject(new Error(stderr || `child exited ${code}`)));
});

try {
  const creators = Array.from({ length: 4 }, (_, i) => run(`import { createRule } from ${JSON.stringify(engine)}; for (let n=0;n<20;n++) createRule({name:'p${i}-'+n,tokenFingerprint:'stress-${i}',enabled:true,trigger:{type:'tool',tool:'stress'},conditions:[],actions:[{tool:'safe',args:{}}]});`));
  await Promise.all(creators);
  const countCode = `import { tokenRules } from ${JSON.stringify(engine)}; const n=[0,1,2,3].reduce((s,i)=>s+tokenRules('stress-'+i).length,0); if(n!==80) throw new Error('expected 80 rules, got '+n);`;
  await run(countCode);

  const ownerCode = `import { createRule } from ${JSON.stringify(engine)}; import fs from 'node:fs'; createRule({name:'claim',tokenFingerprint:'claim-owner',enabled:true,trigger:{type:'tool',tool:'claim'},conditions:[],actions:[{tool:'safe',args:{}}]});`;
  await run(ownerCode);
  const counter = path.join(temp, 'counter.txt');
  const dispatch = `import { dispatchAutomationEvent } from ${JSON.stringify(engine)}; import fs from 'node:fs'; await dispatchAutomationEvent({type:'tool.success',tool:'claim',tokenFingerprint:'claim-owner',ts:Date.now()}, async()=>{ fs.appendFileSync(${JSON.stringify(counter)}, 'x\\n'); await new Promise(r=>setTimeout(r,100)); });`;
  await Promise.all(Array.from({ length: 6 }, () => run(dispatch)));
  const hits = fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8').trim().split('\n').filter(Boolean).length : 0;
  if (hits !== 1) throw new Error(`expected one cross-process execution claim, got ${hits}`);
  console.log('automation stress: 80/80 persistent rules, 1/1 execution claim');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
