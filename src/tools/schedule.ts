import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { assertToolPermitted } from '../core/policy.js';
import { dataDir, shellCommand, childEnv } from '../core/platform.js';
import type { ToolContext } from '../core/context.js';

const exec = promisify(execFile);

// Scheduled tasks live in config dir as JSON; executed by a lightweight
// in-process ticker (checked every 30s). Survives restarts (file-backed),
// one-shot or recurring. Deliberately NOT cron/systemd — we keep everything
// inside the gateway's permission model and audit trail.

interface ScheduledTask {
  id: string;
  command: string;
  run_at?: string;       // ISO — one-shot
  every_seconds?: number; // recurring
  last_run?: string;
  next_run?: string;
  enabled: boolean;
  created: string;
}

function tasksPath(): string {
  return path.join(dataDir(), 'schedule.json');
}

function loadTasks(): ScheduledTask[] {
  try { return JSON.parse(fs.readFileSync(tasksPath(), 'utf8')); }
  catch { return []; }
}

function saveTasks(tasks: ScheduledTask[]): void {
  fs.mkdirSync(path.dirname(tasksPath()), { recursive: true });
  fs.writeFileSync(tasksPath(), JSON.stringify(tasks, null, 2), { mode: 0o600 });
}

/** Start the background ticker. Called once from the server entry. */
export function startScheduler(onRun: (t: ScheduledTask) => void): NodeJS.Timeout {
  return setInterval(async () => {
    const tasks = loadTasks().filter(t => t.enabled);
    const now = Date.now();
    let dirty = false;
    for (const t of tasks) {
      const next = t.next_run ? new Date(t.next_run).getTime() : (t.run_at ? new Date(t.run_at).getTime() : 0);
      if (next && next <= now) {
        try {
          onRun(t);
          t.last_run = new Date().toISOString();
        } finally {
          if (t.every_seconds) {
            t.next_run = new Date(now + t.every_seconds * 1000).toISOString();
          } else {
            t.enabled = false; // one-shot done
          }
          dirty = true;
        }
      }
    }
    if (dirty) saveTasks(tasks);
  }, 30_000);
}

export function registerScheduleTools(server: McpServer, ctx: ToolContext): void {
  // ---- schedule_command -------------------------------------------------------
  server.registerTool('schedule_command',
    {
      description: 'Schedule a shell command: one-shot at an ISO time, or recurring every N seconds. Shell must be enabled.',
      inputSchema: {
        command: z.string().describe('Shell command to run'),
        run_at: z.string().optional().describe('ISO datetime for one-shot execution'),
        every_seconds: z.number().optional().describe('Recur every N seconds (min 60)'),
      },
    },
    async ({ command, run_at, every_seconds }) => {
      assertToolPermitted({ tool: 'schedule_command', scopes: ctx.token.scopes, readOnly: ctx.readOnly });
      if (!ctx.token.shell_enabled) {
        return { content: [{ type: 'text', text: 'Shell is disabled for this token — scheduling refused.' }], isError: true };
      }
      if (!run_at && !every_seconds) {
        return { content: [{ type: 'text', text: 'Provide run_at (one-shot) or every_seconds (recurring).' }], isError: true };
      }
      if (every_seconds && every_seconds < 60) {
        return { content: [{ type: 'text', text: 'Recurring tasks must be >= 60s apart.' }], isError: true };
      }
      const tasks = loadTasks();
      const t: ScheduledTask = {
        id: Math.random().toString(36).slice(2, 10),
        command,
        run_at: run_at || new Date(Date.now() + (every_seconds || 0) * 1000).toISOString(),
        every_seconds,
        next_run: run_at,
        enabled: true,
        created: new Date().toISOString(),
      };
      tasks.push(t);
      saveTasks(tasks);
      return { content: [{ type: 'text', text: `Scheduled task ${t.id}: ${command}` }] };
    });

  // ---- list_scheduled_tasks --------------------------------------------------------
  server.registerTool('list_scheduled_tasks',
    {
      description: 'List all scheduled tasks with their next run times.',
      inputSchema: {},
    },
    async () => {
      assertToolPermitted({ tool: 'list_scheduled_tasks', scopes: ctx.token.scopes, readOnly: ctx.readOnly });
      const tasks = loadTasks();
      if (!tasks.length) return { content: [{ type: 'text', text: '(no scheduled tasks)' }] };
      const out = tasks.map(t =>
        `${t.id} | ${t.enabled ? 'on' : 'off'} | ${t.command} | run_at: ${t.run_at || '-'} | every: ${t.every_seconds || '-'}s | next: ${t.next_run || '-'}`
      ).join('\n');
      return { content: [{ type: 'text', text: out }] };
    });

  // ---- cancel_scheduled_task -----------------------------------------------------------
  server.registerTool('cancel_scheduled_task',
    {
      description: 'Cancel a scheduled task by id.',
      inputSchema: { id: z.string().describe('Task id from list_scheduled_tasks') },
    },
    async ({ id }) => {
      assertToolPermitted({ tool: 'cancel_scheduled_task', scopes: ctx.token.scopes, readOnly: ctx.readOnly });
      const tasks = loadTasks();
      const idx = tasks.findIndex(t => t.id === id);
      if (idx === -1) return { content: [{ type: 'text', text: `Task ${id} not found.` }], isError: true };
      tasks.splice(idx, 1);
      saveTasks(tasks);
      return { content: [{ type: 'text', text: `Cancelled ${id}` }] };
    });
}
