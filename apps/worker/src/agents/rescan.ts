import type { WorkerConfig } from '../config.js';
import { discoverAgents, mergeDiscovery, refreshAvailability } from './discover.js';
import { testAgent } from './test.js';

/**
 * Re-discover installed agents (like `nova-worker discover`) and run the READY test on every enabled, available one.
 * Triggered from the web app, so a worker does not need a restart after claude/codex was installed.
 */
export async function rescanAgents(cfg: WorkerConfig, log: (m: string) => void = () => {}): Promise<WorkerConfig> {
  let next = mergeDiscovery(cfg, await discoverAgents());
  next = await refreshAvailability(next);
  for (const [key, e] of Object.entries(next.agents)) {
    if (!e.enabled || e.available === false) { log(`  agent ${key}: ${e.enabled ? 'not available' : 'disabled'}`); continue; }
    const t = await testAgent(key, e);
    log(`  agent ${key}: ${t.ok ? 'READY' : `test failed (${t.message})`}`);
    next.agents[key] = { ...e, lastTest: t, available: e.source === 'manual' ? e.available : t.ok ? e.available : false };
  }
  return next;
}
