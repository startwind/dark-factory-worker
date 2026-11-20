import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join, resolve } from 'node:path';
import YAML from 'yaml';
import { generateIdentity, type WorkerIdentity } from '@nova/shared/identity';

export interface AgentEntry {
  source: 'auto' | 'manual';
  /** codex | claude | mock | custom — selects the adapter */
  kind?: string;
  command: string;
  enabled: boolean;
  available?: boolean;
  path?: string | null;
  version?: string | null;
  /** container: agent runs INSIDE the job container (default). host: host CLI operates on the workspace (weaker isolation). */
  runtime?: 'container' | 'host';
  /** custom adapters: argument template; {prompt} placeholder or stdin when `stdin: true` */
  args?: string[];
  stdin?: boolean;
  container?: { install?: string; env?: string[]; mounts?: string[] };
  lastTest?: { ok: boolean; at: string; message?: string } | null;
}
export interface WorkerConfig {
  /** maxParallelSteps: how many independent steps of one job may run at the same time (1 = always one after the other) */
  worker: { name: string; maxConcurrentJobs: number; maxParallelSteps?: number };
  server: { url: string };
  podman: { command: string; memory: string; cpus: string; pids: number };
  agents: Record<string, AgentEntry>;
  /** Technical test commands / capabilities only. Routing + permissions live in the master app. */
  capabilities?: Record<string, string>;
}

export const stateDir = () => process.env.NOVA_WORKER_HOME ?? join(homedir(), '.nova-worker');
export const workspacesDir = () => join(stateDir(), 'workspaces');

export function defaultConfig(): WorkerConfig {
  return {
    worker: { name: hostname().replace(/\.local$/, ''), maxConcurrentJobs: 1, maxParallelSteps: 2 },
    server: { url: 'ws://localhost:3001' },
    podman: { command: 'podman', memory: '4g', cpus: '2', pids: 512 },
    agents: {},
  };
}

export function configPath(arg?: string) {
  return resolve(arg ?? process.env.NOVA_WORKER_CONFIG ?? 'worker.config.yaml');
}
export function loadConfig(path: string): WorkerConfig | null {
  if (!existsSync(path)) return null;
  const raw = YAML.parse(readFileSync(path, 'utf8')) as Partial<WorkerConfig>;
  const d = defaultConfig();
  return {
    worker: { ...d.worker, ...raw.worker },
    server: { ...d.server, ...raw.server },
    podman: { ...d.podman, ...raw.podman },
    agents: raw.agents ?? {},
    capabilities: raw.capabilities,
  } as WorkerConfig;
}
export function saveConfig(path: string, cfg: WorkerConfig) {
  const header = '# Nova worker config (technical settings only).\n# Projects, permissions and routing are managed in the Nova master app.\n# source: manual entries are never overwritten by `nova-worker discover`.\n';
  writeFileSync(path, header + YAML.stringify(cfg), { mode: 0o600 });
}

export function loadIdentity(): WorkerIdentity {
  const dir = stateDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const f = join(dir, 'identity.json');
  if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8')) as WorkerIdentity;
  const id = generateIdentity();
  writeFileSync(f, JSON.stringify(id), { mode: 0o600 });
  return id;
}
