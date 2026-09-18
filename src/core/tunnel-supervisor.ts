import { spawn } from 'node:child_process';

interface SupervisorConfig {
  ssh: string;
  args: string[];
}

let config: SupervisorConfig;
try {
  config = JSON.parse(process.argv[2] || '{}') as SupervisorConfig;
} catch {
  console.error('[ramcp] invalid tunnel supervisor configuration');
  process.exit(2);
}

if (!config.ssh || !Array.isArray(config.args)) {
  console.error('[ramcp] invalid tunnel supervisor configuration');
  process.exit(2);
}

let stopping = false;
let current: ReturnType<typeof spawn> | null = null;

const stop = () => {
  stopping = true;
  try { current?.kill(); } catch {}
};

process.on('SIGINT', stop);
process.on('SIGTERM', stop);
process.on('exit', () => { stopping = true; try { current?.kill(); } catch {} });

const run = async () => {
  while (!stopping) {
    current = spawn(config.ssh, config.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    current.stdout?.pipe(process.stdout, { end: false });
    current.stderr?.pipe(process.stderr, { end: false });

    const child = current;
    const code = await new Promise<number | null>((resolve) => {
      child.once('error', (error) => {
        console.error(`[ramcp] localhostrun ssh error: ${error.message}`);
        resolve(null);
      });
      child.once('exit', (exitCode) => resolve(exitCode));
    });

    current = null;
    if (stopping) break;
    console.error(`[ramcp] localhostrun ssh exited (code ${code ?? 'error'}); reconnecting...`);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
};

void run().catch((error) => {
  console.error(`[ramcp] tunnel supervisor failed: ${error?.message || error}`);
  process.exit(1);
});
