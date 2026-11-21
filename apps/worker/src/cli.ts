import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { discoverAgents, mergeDiscovery, refreshAvailability } from './agents/discover.js';
import { testAgent } from './agents/test.js';
import { configPath, defaultConfig, loadConfig, loadIdentity, saveConfig, stateDir, workspacesDir, type WorkerConfig } from './config.js';
import { formatPreflight, runPreflight } from './preflight.js';
import { TOOL_CATALOG } from '@nova/shared';
import { detectTools } from './tools.js';
import { Worker } from './worker.js';

const args = process.argv.slice(2);
const cmd = args[0] ?? 'help';
const flag = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const path = configPath(flag('--config'));

async function testAll(cfg: WorkerConfig, only?: string): Promise<WorkerConfig> {
  for (const [key, e] of Object.entries(cfg.agents)) {
    if (only && key !== only) continue;
    if (!e.enabled || e.available === false) { console.log(`- ${key}: skipped (${e.enabled ? 'not available' : 'disabled'})`); continue; }
    process.stdout.write(`- ${key}: testing (agent must answer READY)… `);
    const t = await testAgent(key, e);
    console.log(t.ok ? '✔ READY' : `✘ ${t.message}`);
    cfg.agents[key] = { ...e, lastTest: t, available: e.available && (e.source === 'manual' ? true : t.ok) ? e.available : t.ok ? e.available : false };
  }
  return cfg;
}

async function init(): Promise<WorkerConfig> {
  console.log('First start: discovering installed agents…');
  let cfg = { ...defaultConfig(), ...(flag('--name') ? { worker: { ...defaultConfig().worker, name: flag('--name')! } } : {}) };
  if (flag('--server')) cfg.server = { url: flag('--server')! };
  if (flag('--max-jobs')) cfg.worker.maxConcurrentJobs = Number(flag('--max-jobs'));
  cfg = mergeDiscovery(cfg, await discoverAgents());
  for (const [k, e] of Object.entries(cfg.agents)) {
    console.log(`  found ${k}: ${e.path} ${e.version ? `(${e.version})` : ''}`);
  }
  if (!Object.keys(cfg.agents).length) console.log('  no agents found (codex / claude). You can add manual entries to the YAML.');
  if (args.includes('--with-mock') && process.env.NOVA_ALLOW_MOCK === 'true') {
    cfg.agents.mock = { source: 'manual', kind: 'mock', command: 'mock', enabled: true, available: true, runtime: 'container' };
    console.log('  added MOCK agent (simulated, no AI) - for credential-free test runs');
  }
  cfg = await testAll(cfg);
  saveConfig(path, cfg);
  console.log(`✔ wrote ${path}`);
  return cfg;
}

const dirSize = (d: string): string => { try { return execFileSync('du', ['-sh', d], { encoding: 'utf8' }).split('\t')[0]!; } catch { return '?'; } };

/** Remove leftover run workspaces (kept after failed/stopped jobs) and optionally the git mirrors. */
function clean() {
  const dry = args.includes('--dry-run');
  const olderH = flag('--older-than') ? Number(flag('--older-than')) : 0;
  const targets: string[] = [];
  const ws = workspacesDir();
  if (existsSync(ws)) {
    for (const n of readdirSync(ws)) {
      const d = join(ws, n);
      const ageH = (Date.now() - statSync(d).mtimeMs) / 3_600_000;
      if (ageH >= olderH) targets.push(d);
    }
  }
  if (args.includes('--mirrors') && existsSync(join(stateDir(), 'mirrors'))) targets.push(join(stateDir(), 'mirrors'));
  if (!targets.length) return void console.log('Nothing to clean.');
  console.log(`${dry ? 'Would remove' : 'Removing'} (stop a running worker first!):`);
  for (const t of targets) {
    console.log(`  ${dirSize(t).padStart(6)}  ${t}`);
    if (!dry) rmSync(t, { recursive: true, force: true });
  }
  console.log(dry ? 'Dry run - nothing deleted.' : `✔ cleaned. Remaining: ${dirSize(stateDir())} in ${stateDir()}`);
}

async function main() {
  switch (cmd) {
    case 'init': await init(); break;
    case 'discover': {
      let cfg = loadConfig(path) ?? defaultConfig();
      cfg = mergeDiscovery(cfg, await discoverAgents());
      cfg = await testAll(cfg);
      saveConfig(path, cfg);
      for (const [k, e] of Object.entries(cfg.agents)) console.log(`${k.padEnd(10)} source=${e.source} available=${e.available} ${e.version ?? ''}`);
      break;
    }
    case 'test': {
      const cfg = loadConfig(path);
      if (!cfg) return void console.error(`No config at ${path}. Run: nova-worker init`);
      saveConfig(path, await testAll(await refreshAvailability(cfg), args[1] && !args[1].startsWith('--') ? args[1] : undefined));
      break;
    }
    case 'doctor': {
      const cfg = loadConfig(path) ?? defaultConfig();
      const h = await runPreflight(cfg);
      for (const l of formatPreflight(h)) console.log(l);
      console.log('\nTool catalog (what steps can require):');
      for (const t of await detectTools()) { const d = TOOL_CATALOG.find((x) => x.id === t.id)!; console.log(`  ${t.available ? '✔' : '·'} ${d.label} [${t.id}]${t.version ? ` (${t.version})` : ''}${t.available ? '' : `\n      → ${d.hint}`}`); }
      process.exitCode = h.checks.some((c) => !c.ok && c.severity === 'required') ? 1 : 0;
      break;
    }
    case 'clean': clean(); break;
    case 'start': {
      let cfg = loadConfig(path);
      if (!cfg) cfg = await init();
      else cfg = await refreshAvailability(cfg); // normal start: availability check only, no discovery
      for (const [k, e] of Object.entries(cfg.agents)) console.log(`  agent ${k}: ${e.available ? 'available' : 'NOT available'} (${e.runtime ?? 'container'}, ${e.source})`);
      const w = new Worker(cfg, loadIdentity(), console.log, path);
      await w.start();
      const bye = () => { console.log('\nshutting down…'); w.stop(); process.exit(0); };
      process.on('SIGINT', bye);
      process.on('SIGTERM', bye);
      break;
    }
    default:
      console.log(`nova-worker <command> [--config worker.config.yaml]

  init        discover + test agents, write worker.config.yaml   [--name N] [--server ws://host:3001] [--max-jobs N]
  discover    re-discover agents (source: auto is updated, source: manual is never touched)
  test [key]  test configured agents (must answer READY)
  doctor      check required tools (git, ssh key, gh) and the tool catalog and print what is missing
  clean       delete leftover run workspaces   [--older-than HOURS] [--mirrors] [--dry-run]
  start       connect to the master app and process jobs (runs init on first start)
`);
  }
  void existsSync;
}
main().catch((e) => { console.error(e); process.exit(1); });
