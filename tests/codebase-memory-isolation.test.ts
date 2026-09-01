import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { resolveCodebaseMemoryRuntimePaths } from '../src/core/integrations.js';

describe('Codebase Memory runtime isolation', () => {
    it('uses a dedicated runtime tree instead of inherited HOME/XDG paths', () => {
        const paths = resolveCodebaseMemoryRuntimePaths({
            HOME: '/home/other-service',
            XDG_CACHE_HOME: '/home/other-service/.cache',
            XDG_DATA_HOME: '/home/other-service/.local/share',
        });

        expect(paths.root).toBe('/var/lib/remote-access-mcp/codebase-memory');
        expect(paths.home).toBe(path.join(paths.root, 'home'));
        expect(paths.cache).toBe(path.join(paths.root, 'cache'));
        expect(paths.data).toBe(path.join(paths.root, 'data'));
        expect(paths.runtime).toBe(path.join(paths.root, 'runtime'));
        expect(paths.workspace).toBe(path.join(paths.root, 'workspace'));
        expect(paths.home).not.toBe('/home/other-service');
        expect(paths.cache).not.toBe('/home/other-service/.cache');
        expect(paths.data).not.toBe('/home/other-service/.local/share');
    });

    it('keeps separate configured instances in separate roots', () => {
        const first = resolveCodebaseMemoryRuntimePaths({
            RAMCP_CODEBASE_RUNTIME: '/var/lib/remote-access-mcp/instances/one',
        });
        const second = resolveCodebaseMemoryRuntimePaths({
            RAMCP_CODEBASE_RUNTIME: '/var/lib/remote-access-mcp/instances/two',
        });

        expect(first.root).not.toBe(second.root);
        expect(first.home).not.toBe(second.home);
        expect(first.cache).not.toBe(second.cache);
        expect(first.data).not.toBe(second.data);
        expect(first.runtime).not.toBe(second.runtime);
        expect(first.workspace).not.toBe(second.workspace);
    });
});
