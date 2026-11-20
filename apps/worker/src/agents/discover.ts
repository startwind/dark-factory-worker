import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { AgentEntry, WorkerConfig } from '../config.js';
import { run, withPath } from '../proc.js';
import { ADAPTERS, adapterFor } from './adapters.js';

export function which(bin: string): string | null {
  const path = (withPath().PATH ?? '').split(delimiter);
  for (const d of path) {
    const p = join(d, bin);
    try {
      accessSync(p, constants.X_OK);
      return p;
    } catch { /* next */ }
  }
  return null;
}

export async function versionOf(cmd: string, args: string[]): Promise<string | null> {
  const r = await run(cmd, args, { env: withPath(), timeoutMs: 15000 });
  if (r.code !== 0) return null;
  return (r.stdout || r.stderr).split('\n')[0].trim() || null;
}

/**
 * Discovery: locate binaries + versions. No functional test here (see test.ts).
 * Runtime default: `container` when an API key for the agent is present in the environment (the CLI can then
 * authenticate inside the container); otherwise `host`, because a login stored on the host is not available in a container.
 */
export async function discoverAgents(): Promise<Record<string, AgentEntry>> {
  const found: Record<string, AgentEntry> = {};
  for (const a of [ADAPTERS.codex, ADAPTERS.claude]) {
    for (const bin of a.binaries) {
      const p = which(bin);
      if (p) found[a.kind] = { source: 'auto', kind: a.kind, command: bin, enabled: true, available: true, path: p, version: await versionOf(p, a.versionArgs), runtime: a.defaultEnv.some((k) => process.env[k]) ? 'container' : 'host', container: { env: a.defaultEnv } };
    }
  }
  return found;
}

/**
 * Merge rules for `nova-worker discover`:
 *  - source: auto may be updated; auto agents no longer found become available:false
 *  - source: manual is NEVER touched (not overwritten, not deleted)
 */
export function mergeDiscovery(cfg: WorkerConfig, found: Record<string, AgentEntry>): WorkerConfig {
  const agents: Record<string, AgentEntry> = { ...cfg.agents };
  for (const [key, entry] of Object.entries(agents)) {
    if (entry.source === 'auto' && !found[key]) agents[key] = { ...entry, available: false };
  }
  for (const [key, entry] of Object.entries(found)) {
    const existing = agents[key];
    if (existing?.source === 'manual') continue;
    agents[key] = { ...existing, ...entry, enabled: existing?.enabled ?? true, runtime: existing?.runtime ?? entry.runtime, container: existing?.container ?? entry.container, lastTest: existing?.lastTest ?? null };
  }
  return { ...cfg, agents };
}

/** Normal start: re-check availability of configured agents only (no new discovery). */
export async function refreshAvailability(cfg: WorkerConfig): Promise<WorkerConfig> {
  const agents = { ...cfg.agents };
  for (const [key, e] of Object.entries(agents)) {
    const ad = adapterFor(key, e);
    if (ad.kind === 'mock') { agents[key] = { ...e, available: e.enabled }; continue; }
    const p = e.command.includes('/') ? e.command : which(e.command);
    agents[key] = { ...e, path: p, available: !!p && e.enabled, version: p ? (await versionOf(p, ad.versionArgs)) ?? e.version : e.version };
  }
  return { ...cfg, agents };
}
