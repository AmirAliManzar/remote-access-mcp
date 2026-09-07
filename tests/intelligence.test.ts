import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { impactAnalysisForTest } from '../src/tools/intelligence.js';
import { getProjectProfile, setProjectProfile } from '../src/core/project-profiles.js';

describe('developer intelligence', () => {
  it('finds reverse dependents through TypeScript imports', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ramcp-impact-'));
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(root, 'src', 'b.ts'), "import { a } from './a.js'; export const b = a;\n");
    fs.writeFileSync(path.join(root, 'src', 'c.ts'), "import { b } from './b.js'; export const c = b;\n");
    const result = await impactAnalysisForTest(root, ['src/a.ts']);
    expect(result.impacted).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
  });

  it('isolates project profiles by token fingerprint', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ramcp-profiles-'));
    const original = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = dir;
    try {
      const a = setProjectProfile('token-a', { root: '/tmp/project-a', name: 'A' });
      expect(a.name).toBe('A');
      expect(getProjectProfile('token-a', '/tmp/project-a')?.name).toBe('A');
      expect(getProjectProfile('token-b', '/tmp/project-a')).toBeUndefined();
    } finally {
      if (original === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = original;
    }
  });
});
