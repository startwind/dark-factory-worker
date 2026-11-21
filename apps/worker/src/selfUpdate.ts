import { execFile, spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));

export const readVersion = (dir: string): string => {
  try { return (JSON.parse(readFileSync(join(dir, 'apps/worker/package.json'), 'utf8')) as { version?: string }).version ?? '0.0.0'; } catch { return '0.0.0'; }
};

/** The git checkout the worker runs from (what install.sh creates). Throws when it is not one. */
export async function installDir(): Promise<string> {
  try {
    const { stdout } = await run('git', ['rev-parse', '--show-toplevel'], { cwd: here });
    return stdout.trim();
  } catch {
    throw new Error('this worker was not installed with install.sh (no git checkout) - update it by hand');
  }
}

/** git pull + npm install. Returns the version now on disk. */
export async function pullAndInstall(dir: string, log: (m: string) => void): Promise<{ before: string; after: string }> {
  const before = readVersion(dir);
  log(`↻ updating worker in ${dir} (now v${before})…`);
  try {
    await run('git', ['-C', dir, 'pull', '--ff-only'], { timeout: 120_000 });
  } catch (e) {
    throw new Error(`git pull failed: ${String((e as { stderr?: string }).stderr ?? (e as Error).message).trim().split('\n').pop()}`);
  }
  try {
    await run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: dir, timeout: 600_000 });
  } catch (e) {
    throw new Error(`npm install failed: ${String((e as { stderr?: string }).stderr ?? (e as Error).message).trim().split('\n').pop()}`);
  }
  return { before, after: readVersion(dir) };
}

/** Started by a service manager (systemd / launchd) that restarts it when it exits? */
export const isSupervised = () => !!process.env.NOVA_SUPERVISED || !!process.env.INVOCATION_ID || (!!process.env.XPC_SERVICE_NAME && process.env.XPC_SERVICE_NAME !== '0');

/**
 * Restart into the new code. Under a service manager: just exit, it starts us again.
 * Otherwise start the same command detached (output goes to ~/.nova-worker/worker.log) and exit.
 */
export function restartSelf(log: (m: string) => void): never {
  if (isSupervised()) {
    log('✔ updated - exiting, the service manager restarts the worker');
    process.exit(0);
  }
  const dir = join(homedir(), '.nova-worker');
  mkdirSync(dir, { recursive: true });
  const out = openSync(join(dir, 'worker.log'), 'a');
  const child = spawn(process.execPath, process.argv.slice(1), { detached: true, stdio: ['ignore', out, out], env: process.env, cwd: process.cwd() });
  child.unref();
  closeSync(out);
  log(`✔ updated - restarted as a background process (log: ${join(dir, 'worker.log')})`);
  process.exit(0);
}
