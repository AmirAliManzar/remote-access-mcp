import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PolicyConfig, assertAllowed } from '../core/policy.js';

export function registerSqliteTools(server: McpServer, policy: PolicyConfig): void {
  // ---- sqlite_query ------------------------------------------------------------------
  server.registerTool('sqlite_query',
    {
      description: 'Run SQL on a SQLite database file (better-sqlite3, synchronous). Policy-checked.',
      inputSchema: {
        db_path: z.string().describe('Database file path'),
        sql: z.string().describe('SQL statement(s)'),
      },
    },
    async ({ db_path, sql }) => {
      assertAllowed(policy, db_path);
      try {
        const { default: Database } = await import('better-sqlite3');
        const db = new (Database as any)(db_path, { readonly: false, fileMustExist: true });
        try {
          const trimmed = sql.trim().toLowerCase();
          const isSelect = trimmed.startsWith('select') || trimmed.startsWith('with') || trimmed.startsWith('pragma');
          if (isSelect) {
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
      assertAllowed(policy, db_path);
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
