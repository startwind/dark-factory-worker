import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { WorkerHealth, WorkerToolCheck } from '@nova/shared';
import { which, versionOf } from './agents/discover.js';
import type { WorkerConfig } from './config.js';
import { run, withPath } from './proc.js';

const firstLine = (s: string) => s.split('\n').find((l) => l.trim())?.trim().slice(0, 200) ?? '';

async function sshKeyCheck(): Promise<WorkerToolCheck> {
  const base = { id: 'ssh-key', label: 'SSH key for GitHub', severity: 'recommended' as const };
  const agent = await run('ssh-add', ['-l'], { env: withPath(), timeoutMs: 8_000 });
  if (agent.code === 0) return { ...base, ok: true, message: 'key available in ssh-agent' };
  const dir = join(homedir(), '.ssh');
  const keys = existsSync(dir) ? readdirSync(dir).filter((f) => /^id_(rsa|ed25519|ecdsa)$/.test(f)) : [];
  if (keys.length) return { ...base, ok: true, message: `found ~/.ssh/${keys.join(', ~/.ssh/')}` };
  return { ...base, ok: false, message: 'no SSH key found (ssh-agent empty, no ~/.ssh/id_*)', hint: 'The worker clones and pushes with its own SSH key. Create one (ssh-keygen -t ed25519) and add it to GitHub as a deploy key with write access.' };
}

/** Start-up tool check. Reported to the master app so admins see what a worker is still missing. */
export async function runPreflight(cfg: WorkerConfig): Promise<WorkerHealth> {
  const checks: WorkerToolCheck[] = [];
  const bin = async (id: string, label: string, name: string, args: string[], severity: WorkerToolCheck['severity'], hint: string) => {
    const p = which(name);
    const version = p ? await versionOf(p, args) : null;
    checks.push(p ? { id, label, ok: true, severity, version, message: 'installed' } : { id, label, ok: false, severity, message: `${name} not found in PATH`, hint });
  };
  await bin('git', 'git', 'git', ['--version'], 'required', 'Install git (brew install git).');
  await bin('ssh', 'ssh client', 'ssh', ['-V'], 'recommended', 'Install an OpenSSH client.');
  checks.push(await sshKeyCheck());
  await bin('gh', 'GitHub CLI (gh)', 'gh', ['--version'], 'recommended', 'Install the GitHub CLI (brew install gh). The worker creates pull requests with it.');
  if (checks.find((c) => c.id === 'gh')?.ok) {
    const a = await run('gh', ['auth', 'status'], { env: withPath(), timeoutMs: 15_000 });
    checks.push(a.code === 0 ? { id: 'gh-auth', label: 'GitHub CLI login', ok: true, severity: 'recommended', message: 'logged in' }
      : { id: 'gh-auth', label: 'GitHub CLI login', ok: false, severity: 'recommended', message: 'gh is not logged in', hint: 'Run: gh auth login (needs permission to create pull requests).' });
  }
  return { checkedAt: new Date().toISOString(), checks };
}

export function formatPreflight(h: WorkerHealth): string[] {
  return h.checks.map((c) => `  ${c.ok ? '✔' : c.severity === 'required' ? '✘' : '⚠'} ${c.label}: ${c.message}${c.version ? ` (${c.version})` : ''}${!c.ok && c.hint ? `\n      → ${c.hint}` : ''}`);
}
