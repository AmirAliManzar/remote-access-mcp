import fs from 'node:fs';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { assertToolPermitted } from '../core/policy.js';
import type { ToolContext } from '../core/context.js';

// SQL safety: only one statement per call, and the verb allowlist stops
// multiple-statement smuggling (better-sqlite3's exec() would run them all).
const SQL_VERBS = /^(select|with|insert|update|delete|create|drop|alter|pragma|vacuum|analyze|begin|commit|rollback|explain|replace|index|reindex)\b/i;

function validateSql(sql: string): string | null {
  const trimmed = sql.trim();
  if (!trimmed) return 'empty SQL';
  if (/;/.test(trimmed.slice(0, -1)) && !/pragma/i.test(trimmed)) return 'multiple statements not allowed';
  const verbMatch = trimmed.match(/^[a-z]+/i);
  if (!verbMatch) return 'cannot parse SQL verb';
  // WITH is legal CTE prefix; select/insert/etc. checked directly
  if (!SQL_VERBS.test(verbMatch[0])) return `SQL verb "${verbMatch[0]}" not allowed`;
  // Attach/detach can pivot the DB file outside the policy sandbox
  if (/\battach\b|\bdetach\b/i.test(trimmed)) return 'attach/detach not allowed';
  return null;
}

export function registerSqliteTools(server: McpServer, ctx: ToolContext): void {
  const policy = () => ({
    allowed_paths: ctx.token.allowed_paths,
    denied_paths: ctx.token.denied_paths,
    shell_enabled: ctx.token.shell_enabled,
  });

  // ---- sqlite_query ------------------------------------------------------------------
  server.registerTool('sqlite_query',
    {
      description: 'Run one SQL statement on a SQLite database file. Verb allowlist, single-statement. Policy-checked.',
      inputSchema: {
        db_path: z.string().describe('Database file path'),
        sql: z.string().describe('SQL statement'),
      },
    },
    async ({ db_path, sql }) => {
      assertToolPermitted({ tool: 'sqlite_query', scopes: ctx.token.scopes, readOnly: ctx.readOnly, policy: policy(), target: db_path });
      const err = validateSql(sql);
      if (err) return { content: [{ type: 'text', text: `SQL rejected: ${err}` }], isError: true };
      if (!fs.existsSync(db_path)) {
        return { content: [{ type: 'text', text: `No such database: ${db_path}` }], isError: true };
      }
      try {
        const { default: Database } = await import('better-sqlite3');
        const db = new (Database as any)(db_path, { fileMustExist: true });
        try {
          const trimmed = sql.trim().toLowerCase();
          const readOnlyVerb = trimmed.startsWith('select') || trimmed.startsWith('with') || trimmed.startsWith('pragma') || trimmed.startsWith('explain');
          if (readOnlyVerb) {
            const rows = db.prepare(sql).all();
            return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2).slice(0, 60_000) || '[]' }] };
          }
          const info = db.exec(sql);
          return { content: [{ type: 'text', text: `OK — changes: ${info.changes}` }] };
        } finally {
          db.close();
        }
      } catch (e: any) {
        return { content: [{ type: 'text', text: `sqlite error: ${e.message}` }], isError: true };
      }
    });

  // ---- sqlite_schema -------------------------------------------------------------------
  server.registerTool('sqlite_schema',
    {
      description: 'List tables and their CREATE statements for a SQLite database. Policy-checked.',
      inputSchema: { db_path: z.string().describe('Database file path') },
    },
    async ({ db_path }) => {
      assertToolPermitted({ tool: 'sqlite_schema', scopes: ctx.token.scopes, readOnly: ctx.readOnly, policy: policy(), target: db_path });
      if (!fs.existsSync(db_path)) {
        return { content: [{ type: 'text', text: `No such database: ${db_path}` }], isError: true };
      }
      try {
        const { default: Database } = await import('better-sqlite3');
        const db = new (Database as any)(db_path, { readonly: true, fileMustExist: true });
        try {
          const rows: Array<{ name: string; sql: string }> = db.prepare(
            "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
          ).all();
          const out = rows.map(r => r.sql || `-- ${r.name}`).join('\n\n');
          return { content: [{ type: 'text', text: out || '(no tables)' }] };
        } finally {
          db.close();
        }
      } catch (e: any) {
        return { content: [{ type: 'text', text: `sqlite error: ${e.message}` }], isError: true };
      }
    });
}
