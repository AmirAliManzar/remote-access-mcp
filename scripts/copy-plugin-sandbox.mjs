import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'src', 'tools', 'plugin-network-blocker.cjs');
const target = path.join(root, 'dist', 'tools', 'plugin-network-blocker.cjs');
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.copyFileSync(source, target);
