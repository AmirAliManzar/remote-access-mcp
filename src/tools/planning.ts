import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { assertToolPermitted, assertAllowed } from '../core/policy.js';
import type { ToolContext } from '../core/context.js';

/**
 * Planning toolkit: task plans + workspace snapshots with rollback.
 * Snapshots are content-addressed file copies inside the config dir —
 * the AI can snapshot before a risky edit and roll back atomically.
 */

interface TaskPlan {
  id: string;
  goal: string;
  steps: Array<{ text: string; done: boolean }>;
  created: string;
  updated: string;
}

interface Snapshot {
  id: string;
  root: string;          // original directory
  files: Array<{ orig: string; snap: string }>;
  created: string;
}

function storePath(kind: 'plans' | 'snapshots'): string {
  const os = require('node:os') as typeof import('node:os');
  return path.join(os.homedir(), '.config', 'remote-access-mcp', `${kind}.json`);
}

function loadStore<T>(kind: 'plans' | 'snapshots'): T[] {
  try { return JSON.parse(fs.readFileSync(storePath(kind), 'utf8')); }
  catch { return []; }
}

function saveStore<T>(kind: 'plans' | 'snapshots', data: T[]): void {
  fs.mkdirSync(path.dirname(storePath(kind)), { recursive: true });
  fs.writeFileSync(storePath(kind), JSON.stringify(data, null, 2), { mode: 0o600 });
}

function snapDir(): string {
  const os = require('node:os') as typeof import('node:os');
  return path.join(os.homedir(), '.config', 'remote-access-mcp', 'snapshots');
}

export function registerPlanningTools(server: McpServer, ctx: ToolContext): void {
  const policy = () => ({
    allowed_paths: ctx.token.allowed_paths,
    denied_paths: ctx.token.denied_paths,
    shell_enabled: ctx.token.shell_enabled,
  });

  // ---- create_task_plan ---------------------------------------------------------
  server.registerTool('create_task_plan',
    {
      description: 'Create a multi-step task plan the AI can track. Steps can be marked done via task_status.',
      inputSchema: {
        goal: z.string().describe('What the plan achieves'),
        steps: z.array(z.string()).describe('Ordered steps'),
      },
    },
    async ({ goal, steps }) => {
      assertToolPermitted({ tool: 'create_task_plan', scopes: ctx.token.scopes, readOnly: ctx.readOnly });
      const plans = loadStore<TaskPlan>('plans');
      const plan: TaskPlan = {
        id: crypto.randomBytes(4).toString('hex'),
        goal,
        steps: steps.map(s => ({ text: s, done: false })),
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
      };
      plans.push(plan);
      saveStore('plans', plans);
      return { content: [{ type: 'text', text: `Plan ${plan.id} created with ${steps.length} steps: ${goal}` }] };
    });

  // ---- task_status --------------------------------------------------------------------
  server.registerTool('task_status',
    {
      description: 'Show a task plan, or mark steps done by index (1-based).',
      inputSchema: {
        id: z.string().describe('Plan id'),
        done_steps: z.array(z.number()).optional().describe('1-based step indices to mark done'),
      },
    },
    async ({ id, done_steps }) => {
      assertToolPermitted({ tool: 'task_status', scopes: ctx.token.scopes, readOnly: ctx.readOnly });
      const plans = loadStore<TaskPlan>('plans');
      const plan = plans.find(p => p.id === id);
      if (!plan) return { content: [{ type: 'text', text: `Plan ${id} not found.` }], isError: true };
      if (done_steps) {
        for (const i of done_steps) {
          if (plan.steps[i - 1]) plan.steps[i - 1].done = true;
        }
        plan.updated = new Date().toISOString();
        saveStore('plans', plans);
      }
      const lines = plan.steps.map((s, i) => `${i + 1}. [${s.done ? 'x' : ' '}] ${s.text}`);
      return { content: [{ type: 'text', text: `Plan ${plan.id}: ${plan.goal}\n${lines.join('\n')}` }] };
    });

  // ---- workspace_snapshot ---------------------------------------------------------------
  server.registerTool('workspace_snapshot',
    {
      description: 'Snapshot files (copy) before a risky change. Roll back with rollback_changes. Policy-checked.',
      inputSchema: {
        files: z.array(z.string()).describe('Absolute file paths to snapshot'),
      },
    },
    async ({ files }) => {
      assertToolPermitted({ tool: 'workspace_snapshot', scopes: ctx.token.scopes, readOnly: ctx.readOnly, policy: policy() });
      const id = crypto.randomBytes(6).toString('hex');
      const dir = path.join(snapDir(), id);
      fs.mkdirSync(dir, { recursive: true });
      const recs: Snapshot['files'] = [];
      for (const f of files) {
        assertAllowed(policy(), f);
        const dest = path.join(dir, crypto.createHash('sha1').update(f).digest('hex').slice(0, 12) + path.basename(f));
        await fsp.copyFile(f, dest);
        recs.push({ orig: f, snap: dest });
      }
      const snaps = loadStore<Snapshot>('snapshots');
      snaps.push({ id, root: path.dirname(files[0] || '.'), files: recs, created: new Date().toISOString() });
      saveStore('snapshots', snaps);
      return { content: [{ type: 'text', text: `Snapshot ${id}: ${files.length} file(s) saved.` }] };
    });

  // ---- rollback_changes ---------------------------------------------------------------------
  server.registerTool('rollback_changes',
    {
      description: 'Restore files from a snapshot. Policy-checked.',
      inputSchema: { id: z.string().describe('Snapshot id from workspace_snapshot') },
    },
    async ({ id }) => {
      assertToolPermitted({ tool: 'rollback_changes', scopes: ctx.token.scopes, readOnly: ctx.readOnly, policy: policy() });
      const snaps = loadStore<Snapshot>('snapshots');
      const snap = snaps.find(s => s.id === id);
      if (!snap) return { content: [{ type: 'text', text: `Snapshot ${id} not found.` }], isError: true };
      for (const f of snap.files) {
        assertAllowed(policy(), f.orig);
        await fsp.copyFile(f.snap, f.orig);
      }
      return { content: [{ type: 'text', text: `Rolled back ${snap.files.length} file(s) from snapshot ${id}.` }] };
    });
}
