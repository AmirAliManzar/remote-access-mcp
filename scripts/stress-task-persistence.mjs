import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { TaskEngine } from '../dist/core/task-engine.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ramcp-task-stress-'));
const workers = 4;
const perWorker = 20;
const code = `import { TaskEngine } from './dist/core/task-engine.js'; const dir=process.argv[1]; const e=new TaskEngine('stress-token', async()=>({content:[{type:'text',text:'ok'}]}), {dataDirectory:dir}); for(let i=0;i<${perWorker};i++) e.create({goal:'stress',autonomy:'safe',actions:[{id:'a',tool:'system_info'}]});`;
const children = Array.from({ length: workers }, () => new Promise((resolve, reject) => {
  const p = spawn(process.execPath, ['--input-type=module', '-e', code, dir], { cwd: path.resolve('.') });
  let stderr = ''; p.stderr.on('data', x => { stderr += x; });
  p.on('close', code => code === 0 ? resolve() : reject(new Error(stderr || `child exited ${code}`)));
}));
await Promise.all(children);
const engine = new TaskEngine('stress-token', async()=>({content:[]} ), { dataDirectory: dir });
const count = engine.list(100).length;
console.log(JSON.stringify({ workers, perWorker, expected: workers * perWorker, persisted: count, ok: count === workers * perWorker }));
fs.rmSync(dir, { recursive: true, force: true });
if (count !== workers * perWorker) process.exitCode = 1;
