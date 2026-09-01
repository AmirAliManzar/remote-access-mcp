import { webcrypto } from 'node:crypto';

/**
 * Node.js 18 does not guarantee a global `crypto` in every execution
 * environment (notably some test/embedded runtimes). The MCP SDK uses the
 * Web Crypto global, so provide the standards-compatible Node implementation
 * when it is missing.
 */
if (!globalThis.crypto) {
    Object.defineProperty(globalThis, 'crypto', {
        value: webcrypto,
        configurable: true,
        enumerable: true,
    });
}
