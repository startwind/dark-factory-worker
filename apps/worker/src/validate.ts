import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ValidationJobPayload, ValidationResultPayload } from '@nova/shared';
import { makeRedactor } from '@nova/shared';
import { checkRemoteAccess } from './git.js';
import { run } from './proc.js';

const firstLine = (s: string) => s.trim().split('\n').filter(Boolean).slice(-1)[0] ?? '';

function publicKeys(): string[] {
  const dir = join(homedir(), '.ssh');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /^id_.*\.pub$/.test(f)).map((f) => readFileSync(join(dir, f), 'utf8').trim());
}

/**
 * Onboarding check from the worker's point of view: can it read the repository with its own
 * credentials (SSH key) and open pull requests (gh login)? Nothing is cloned, run or pushed.
 */
export async function validateProject(p: ValidationJobPayload): Promise<ValidationResultPayload> {
  const redact = makeRedactor([p.repo.authToken ?? '']);
  const log: string[] = [];
  const problems: string[] = [];

  const ls = await checkRemoteAccess(p.repo.cloneUrl, p.repo.defaultBranch, { user: p.repo.authUser, token: p.repo.authToken });
  if (ls.code === 0) log.push(`✔ git ls-remote ${p.repo.cloneUrl} (${p.repo.defaultBranch})`);
  else {
    log.push(`✘ git ls-remote ${p.repo.cloneUrl}: ${firstLine(ls.stderr || ls.stdout)}`);
    problems.push('cannot read the repository');
    const keys = publicKeys();
    log.push(keys.length
      ? `Add this worker's public key as a deploy key (Repo → Settings → Deploy keys, write access) or to your GitHub account:\n  ${keys.join('\n  ')}`
      : 'This worker has no SSH key (~/.ssh/id_*). Create one: ssh-keygen -t ed25519');
  }

  const gh = await run('gh', ['auth', 'status'], { timeoutMs: 15_000 });
  if (gh.code === 0) log.push('✔ gh is logged in (pull requests)');
  else {
    log.push(`✘ gh: ${firstLine(gh.stderr || gh.stdout) || 'not available'}`);
    problems.push('cannot open pull requests (run: gh auth login, or set GH_TOKEN)');
  }

  const ok = problems.length === 0;
  return {
    ok, dockerfileFound: false, buildOk: false,
    message: ok ? 'The worker can read the repository and open pull requests' : `This worker ${problems.join(' and ')}`,
    log: redact(log.join('\n')),
  };
}
