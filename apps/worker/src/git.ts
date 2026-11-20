import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stateDir } from './config.js';
import { run, type RunOpts } from './proc.js';

export interface GitAuth { user?: string | null; token?: string | null }

/** Credentials are passed via GIT_ASKPASS for the process lifetime only: never in the URL, git config or the container. */
function authEnv(a: GitAuth): { env: NodeJS.ProcessEnv; cleanup: () => void } {
  // The worker uses ITS OWN ssh keys / agent / ~/.ssh/config. BatchMode: fail fast instead of hanging on a prompt.
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new' };
  if (!a.token) return { env, cleanup: () => undefined };
  const dir = mkdtempSync(join(tmpdir(), 'nova-askpass-'));
  const f = join(dir, 'askpass.sh');
  writeFileSync(f, '#!/bin/sh\ncase "$1" in *sername*) echo "$NOVA_GIT_USER";; *) echo "$NOVA_GIT_TOKEN";; esac\n');
  chmodSync(f, 0o700);
  env.GIT_ASKPASS = f;
  env.NOVA_GIT_USER = a.user ?? 'x-access-token';
  env.NOVA_GIT_TOKEN = a.token;
  return { env, cleanup: () => void run('rm', ['-rf', dir]) };
}

/** One persistent bare mirror per remote: the full history is downloaded once, every job then clones locally from it (hardlinks, seconds). */
export const mirrorDir = (url: string) => join(stateDir(), 'mirrors', `${createHash('sha1').update(url).digest('hex').slice(0, 16)}.git`);
const mirrorLocks = new Map<string, Promise<unknown>>();
function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const next = (mirrorLocks.get(key) ?? Promise.resolve()).catch(() => undefined).then(fn);
  mirrorLocks.set(key, next);
  return next;
}

const IDENT = ['-c', 'user.name=Nova Factory', '-c', 'user.email=factory@nova.local'];

export class Git {
  constructor(private cwd: string, private auth: GitAuth = {}, private onLog?: (s: string) => void) {}

  private async git(args: string[], o: RunOpts = {}, cwd = this.cwd) {
    const { env, cleanup } = authEnv(this.auth);
    try {
      const r = await run('git', [...IDENT, ...args], { cwd, env, timeoutMs: 300_000, ...o });
      if (r.code !== 0 && !o.onStdout) this.onLog?.(`git ${args[0]} failed: ${(r.stderr || r.stdout).trim().slice(-400)}`);
      return r;
    } finally {
      cleanup();
    }
  }

  async clone(url: string, branch: string, defaultBranch: string, parent: string, dir: string) {
    mkdirSync(parent, { recursive: true });
    const mirror = mirrorDir(url);
    let source = url;
    try {
      await withLock(mirror, async () => {
        if (existsSync(join(mirror, 'HEAD'))) {
          const f = await this.git(['fetch', '--prune', '--force', 'origin', '+refs/heads/*:refs/heads/*'], {}, mirror);
          if (f.code !== 0) throw new GitError('fetch', f.stderr || f.stdout);
        } else {
          mkdirSync(join(stateDir(), 'mirrors'), { recursive: true });
          const c = await this.git(['clone', '--mirror', url, mirror], {}, parent);
          if (c.code !== 0) throw new GitError('clone', c.stderr || c.stdout);
        }
      });
      source = mirror;
    } catch (e) {
      this.onLog?.(`mirror unavailable (${(e as Error).message.slice(0, 200)}): cloning directly`);
    }
    const r = await this.git(['clone', '--branch', defaultBranch, source, dir], {}, parent);
    if (r.code !== 0) throw new GitError('clone', r.stderr || r.stdout);
    if (source !== url) await this.git(['remote', 'set-url', 'origin', url], {}, join(parent, dir)); // push / PR go to the real remote
    // resume previous work if the ticket branch already exists remotely
    const ls = await this.git(['ls-remote', '--heads', 'origin', branch]);
    if (ls.stdout.trim()) {
      const f = await this.git(['fetch', 'origin', branch]);
      if (f.code !== 0) throw new GitError('fetch', f.stderr);
      const c = await this.git(['checkout', '-B', branch, `origin/${branch}`]);
      if (c.code !== 0) throw new GitError('checkout', c.stderr);
    } else {
      const c = await this.git(['checkout', '-b', branch]);
      if (c.code !== 0) throw new GitError('checkout', c.stderr);
    }
    this.exclude('.nova/');
  }

  exclude(pattern: string) {
    try { appendFileSync(join(this.cwd, '.git', 'info', 'exclude'), `${pattern}\n`); } catch { /* ignore */ }
  }

  async changedFiles(): Promise<number> {
    const r = await this.git(['status', '--porcelain']);
    return r.stdout.split('\n').filter(Boolean).length;
  }

  /** returns false if there was nothing to commit */
  async commitAll(message: string): Promise<boolean> {
    await this.git(['add', '-A']);
    if ((await this.changedFiles()) === 0) return false;
    const r = await this.git(['commit', '-m', message]);
    if (r.code !== 0) throw new GitError('commit', r.stderr || r.stdout);
    return true;
  }

  /** Creates the PR with the worker's own `gh` login (the server token is read-only). Returns the PR URL + number. */
  async createPullRequest(a: { branch: string; base: string; title: string; body: string }): Promise<{ url: string; number: number }> {
    const { env, cleanup } = authEnv({});
    try {
      env.GH_PROMPT_DISABLED = '1';
      const r = await run('gh', ['pr', 'create', '--head', a.branch, '--base', a.base, '--title', a.title, '--body', a.body], { cwd: this.cwd, env, timeoutMs: 60_000 });
      if (r.code === 127 || /ENOENT/.test(r.stderr)) throw new GitError('pr', 'GitHub CLI (`gh`) is not installed on this worker. Install it and run `gh auth login` (the worker creates pull requests with its own credentials).');
      const out = `${r.stdout}\n${r.stderr}`;
      const m = out.match(/https:\/\/[^\s]+\/pull\/(\d+)/);
      if (!m) throw new GitError('pr', r.stderr || r.stdout);
      return { url: m[0], number: Number(m[1]) }; // also covers "a pull request already exists: <url>"
    } finally {
      cleanup();
    }
  }

  async push(branch: string) {
    const r = await this.git(['push', '-u', 'origin', branch]);
    if (r.code !== 0) throw new GitError('push', r.stderr || r.stdout);
  }
}

/** Read access check: `git ls-remote` on the default branch with the worker's own credentials. */
export async function checkRemoteAccess(url: string, branch: string, auth: GitAuth) {
  const { env, cleanup } = authEnv(auth);
  try { return await run('git', ['ls-remote', '--exit-code', url, `refs/heads/${branch}`], { env, timeoutMs: 30_000 }); } finally { cleanup(); }
}

export class GitError extends Error {
  constructor(public op: string, detail: string) {
    super(`git ${op} failed: ${detail.trim().slice(-500)}`);
  }
}
export const isConflict = (e: unknown) => e instanceof GitError && /non-fast-forward|rejected|conflict|diverged/i.test(e.message);
