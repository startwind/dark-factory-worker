import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ValidationJobPayload, ValidationResultPayload } from '@nova/shared';
import { makeRedactor } from '@nova/shared';
import type { WorkerConfig } from './config.js';
import { Git } from './git.js';
import type { Podman } from './podman.js';

/** Onboarding step: clone, check Dockerfile, build image. Nothing is run or pushed. */
export async function validateProject(p: ValidationJobPayload, podman: Podman, _cfg: WorkerConfig): Promise<ValidationResultPayload> {
  const redact = makeRedactor([p.repo.authToken ?? '']);
  let log = '';
  const add = (s: string) => { log = (log + redact(s)).slice(-20000); };
  const parent = mkdtempSync(join(tmpdir(), 'nova-validate-'));
  const tag = `nova-validate-${Date.now()}`;
  try {
    const git = new Git(join(parent, 'repo'), { user: p.repo.authUser, token: p.repo.authToken }, add);
    try {
      await git.clone(p.repo.cloneUrl, `nova-validate-${Date.now()}`, p.repo.defaultBranch, parent, 'repo');
    } catch (e) {
      return { ok: false, dockerfileFound: false, buildOk: false, message: `Clone failed: ${(e as Error).message}`, log };
    }
    const found = existsSync(join(parent, 'repo', p.dockerfilePath));
    if (!found) return { ok: true, dockerfileFound: false, buildOk: false, message: `No ${p.dockerfilePath} in the repository: jobs run directly on the worker host (no container isolation)`, log };
    const pm = await podman.available();
    if (!pm.ok) return { ok: false, dockerfileFound: true, buildOk: false, message: `Podman unavailable: ${pm.message}`, log };
    const r = await podman.build(tag, join(parent, 'repo'), p.dockerfilePath, { timeoutMs: 15 * 60_000, onStdout: add, onStderr: add });
    return r.code === 0
      ? { ok: true, dockerfileFound: true, buildOk: true, message: 'Dockerfile found and container build succeeded', log }
      : { ok: false, dockerfileFound: true, buildOk: false, message: `Container build failed (exit ${r.code})`, log };
  } finally {
    await podman.rmi(tag).catch(() => undefined);
    rmSync(parent, { recursive: true, force: true });
  }
}
