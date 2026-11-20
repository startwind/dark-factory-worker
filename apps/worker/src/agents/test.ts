import type { AgentEntry } from '../config.js';
import { run, withPath } from '../proc.js';
import { adapterFor } from './adapters.js';

/** Functional test: the agent must really answer READY through its CLI. */
export async function testAgent(key: string, e: AgentEntry, timeoutMs = 120_000): Promise<{ ok: boolean; at: string; message: string }> {
  const ad = adapterFor(key, e);
  const inv = ad.buildTest(e);
  const r = await run(inv.cmd, inv.args, { stdin: inv.stdin, env: withPath(), timeoutMs });
  const out = `${r.stdout}\n${r.stderr}`;
  const at = new Date().toISOString();
  if (r.timedOut) return { ok: false, at, message: `timed out after ${timeoutMs / 1000}s` };
  if (r.code !== 0) return { ok: false, at, message: `exit ${r.code}: ${out.trim().split('\n').slice(-3).join(' | ').slice(0, 300)}` };
  if (!/\bREADY\b/.test(r.stdout)) return { ok: false, at, message: `no READY in answer: ${r.stdout.trim().slice(0, 200)}` };
  return { ok: true, at, message: 'READY' };
}
