import { spawn } from 'node:child_process';

export interface RunOpts {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onStdout?: (s: string) => void;
  onStderr?: (s: string) => void;
}
export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  stdout: string;
  stderr: string;
}

/** Runs a process with streaming callbacks, timeout and abort. SIGTERM first, SIGKILL after 5s. */
export function run(cmd: string, args: string[], o: RunOpts = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd: o.cwd, env: o.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ code: 127, signal: null, timedOut: false, aborted: false, stdout: '', stderr: String(e) });
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    const MAX = 2_000_000;
    child.stdout.on('data', (d: Buffer) => {
      const s = d.toString();
      stdout = (stdout + s).slice(-MAX);
      o.onStdout?.(s);
    });
    child.stderr.on('data', (d: Buffer) => {
      const s = d.toString();
      stderr = (stderr + s).slice(-MAX);
      o.onStderr?.(s);
    });
    const kill = () => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    };
    const timer = o.timeoutMs ? setTimeout(() => { timedOut = true; kill(); }, o.timeoutMs) : null;
    const onAbort = () => { aborted = true; kill(); };
    if (o.signal) {
      if (o.signal.aborted) onAbort();
      else o.signal.addEventListener('abort', onAbort, { once: true });
    }
    child.on('error', (e) => { stderr += String(e); resolve({ code: 127, signal: null, timedOut, aborted, stdout, stderr }); });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);
      resolve({ code, signal, timedOut, aborted, stdout, stderr });
    });
    if (o.stdin !== undefined) child.stdin.end(o.stdin);
    else child.stdin.end();
  });
}

export function withPath(): NodeJS.ProcessEnv {
  const extra = [`${process.env.HOME}/.local/bin`, '/opt/homebrew/bin', '/usr/local/bin'];
  return { ...process.env, PATH: [...extra, process.env.PATH ?? ''].join(':') };
}
