import { run, type RunOpts, type RunResult } from './proc.js';
import { shq } from './agents/adapters.js';

export interface ContainerLimits { memory: string; cpus: string; pids: number }

export class Podman {
  constructor(private cmd = 'podman') {}

  async available(): Promise<{ ok: boolean; message: string }> {
    // plain `info` works for both podman and docker
    const r = await run(this.cmd, ['info'], { timeoutMs: 20000 });
    return r.code === 0 ? { ok: true, message: `${this.cmd} ok` } : { ok: false, message: (r.stderr || `${this.cmd} not reachable (is the machine/daemon running?)`).trim().slice(0, 300) };
  }

  build(tag: string, contextDir: string, dockerfile: string, o: RunOpts) {
    return run(this.cmd, ['build', '-t', tag, '-f', dockerfile, '.'], { ...o, cwd: contextDir });
  }

  /**
   * Unprivileged job container: dropped capabilities, no-new-privileges, resource limits,
   * only the workspace is mounted. Secrets are never passed at start (only per-exec env).
   */
  async start(name: string, image: string, workspace: string, limits: ContainerLimits, extraMounts: string[] = []): Promise<RunResult> {
    const mounts = extraMounts.flatMap((m) => ['-v', m]);
    return run(this.cmd, [
      'run', '-d', '--name', name,
      '--cap-drop=ALL', '--cap-add=CHOWN', '--cap-add=DAC_OVERRIDE', '--cap-add=FOWNER', '--cap-add=SETUID', '--cap-add=SETGID',
      '--security-opt', 'no-new-privileges',
      '--memory', limits.memory, '--cpus', limits.cpus, '--pids-limit', String(limits.pids),
      '-v', `${workspace}:/workspace`, ...mounts, '-w', '/workspace',
      '--label', 'nova-factory=job',
      '--entrypoint', 'sh', image, '-c', 'while true; do sleep 3600; done',
    ], { timeoutMs: 60000 });
  }

  exec(name: string, argv: string[], o: RunOpts & { env?: Record<string, string>; passEnv?: string[] }) {
    const envArgs: string[] = [];
    for (const [k, v] of Object.entries(o.env ?? {})) envArgs.push('-e', `${k}=${v}`);
    for (const k of o.passEnv ?? []) if (process.env[k]) envArgs.push('-e', `${k}=${process.env[k]}`);
    return run(this.cmd, ['exec', '-i', '-w', '/workspace', ...envArgs, name, ...argv], { ...o, env: process.env });
  }
  sh(name: string, script: string, o: Parameters<Podman['exec']>[2]) {
    return this.exec(name, ['sh', '-lc', script], o);
  }

  async stop(name: string, graceSec = 5) {
    await run(this.cmd, ['stop', '-t', String(graceSec), name], { timeoutMs: (graceSec + 20) * 1000 });
  }
  async kill(name: string) {
    await run(this.cmd, ['kill', name], { timeoutMs: 15000 });
  }
  async rm(name: string) {
    await run(this.cmd, ['rm', '-f', name], { timeoutMs: 30000 });
  }
  async rmi(tag: string) {
    await run(this.cmd, ['rmi', '-f', tag], { timeoutMs: 30000 });
  }
  async has(name: string, bin: string) {
    const r = await this.sh(name, `command -v ${shq(bin)}`, { timeoutMs: 20000 });
    return r.code === 0;
  }
}
