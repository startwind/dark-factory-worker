import { readFileSync } from 'node:fs';
import { hostname, platform } from 'node:os';
import { io, type Socket } from 'socket.io-client';
import { fingerprint, signChallenge, type WorkerIdentity } from '@nova/shared/identity';
import { missingTools, schedulingToolIds, type JobPayload, type LogChunk, type WorkerAgentInfo, type WorkerAuthPayload, type WorkerHealth, type WorkerHello, type WorkerToolInfo } from '@nova/shared';
import { adapterFor } from './agents/adapters.js';
import { rescanAgents } from './agents/rescan.js';
import { installDir, pullAndInstall, restartSelf } from './selfUpdate.js';
import { saveConfig, type WorkerConfig } from './config.js';
import { JobRunner, type ServerLink } from './jobRunner.js';
import { Podman } from './podman.js';
import { formatPreflight, runPreflight } from './preflight.js';
import { describeMissing, detectTools } from './tools.js';
import { validateProject } from './validate.js';

/** Version of the installed worker = version in apps/worker/package.json (kept in step with the app releases). */
const VERSION = (() => {
  try { return (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string }).version ?? '0.0.0'; } catch { return '0.0.0'; }
})();

export function agentInfos(cfg: WorkerConfig): WorkerAgentInfo[] {
  return Object.entries(cfg.agents).map(([key, e]) => ({
    key, kind: (adapterFor(key, e).kind as WorkerAgentInfo['kind']), available: !!e.enabled && e.available !== false, version: e.version ?? null, path: e.path ?? null,
    source: e.source, runtime: e.runtime ?? 'container', lastTest: e.lastTest ?? null,
  }));
}

export class Worker {
  private jobs = new Map<string, JobRunner>();
  private socket!: Socket;
  private hb: NodeJS.Timeout | null = null;
  private approved = false;
  private health?: WorkerHealth;
  private tools: WorkerToolInfo[] = [];
  private podman: Podman;

  private rescanning = false;
  private updating = false;
  constructor(private cfg: WorkerConfig, private identity: WorkerIdentity, private log: (m: string) => void = console.log, private cfgPath?: string) {
    this.podman = new Podman(cfg.podman.command);
  }

  private serverHttp() {
    return this.cfg.server.url.replace(/^ws/, 'http').replace(/\/$/, '');
  }

  private hello(): WorkerHello {
    return {
      fingerprint: fingerprint(this.identity.publicKey), publicKey: this.identity.publicKey, name: this.cfg.worker.name, hostname: hostname(), platform: platform(),
      maxConcurrentJobs: this.cfg.worker.maxConcurrentJobs, agents: agentInfos(this.cfg), tools: this.tools, activeJobs: [...this.jobs.keys()], version: VERSION, health: this.health,
    };
  }

  /** Active connect (worker -> master). Each (re)connect fetches a fresh challenge and signs it with the durable identity. */
  async start() {
    // One-time tool check; the result is sent to the master app in every (re)connect handshake.
    this.health = await runPreflight(this.cfg);
    this.tools = await detectTools();
    this.log('Tool check:');
    for (const l of formatPreflight(this.health)) this.log(l);
    const missing = this.health.checks.filter((c) => !c.ok);
    this.log(`Tool catalog: ${this.tools.filter((t) => t.available).map((t) => t.id).join(', ') || 'nothing'} available${this.tools.some((t) => !t.available) ? `; missing: ${this.tools.filter((t) => !t.available).map((t) => t.id).join(', ')}` : ''}`);
    if (missing.length) this.log(`⚠ ${missing.length} tool(s) missing - reported to the master app${missing.some((c) => c.severity === 'required') ? ' (jobs will fail until the required ones are fixed)' : ''}`);
    this.socket = io(`${this.serverHttp()}/worker`, {
      transports: ['websocket'], reconnection: true, reconnectionDelay: 1000, reconnectionDelayMax: 10_000,
      auth: (cb) => {
        void (async () => {
          try {
            const r = (await (await fetch(`${this.serverHttp()}/api/worker/challenge`)).json()) as { challenge: string };
            const payload: WorkerAuthPayload & { challenge: string } = { challenge: r.challenge, hello: this.hello(), signature: signChallenge(this.identity, r.challenge) };
            cb(payload);
          } catch (e) {
            this.log(`✘ cannot reach master: ${(e as Error).message}`);
            cb({});
          }
        })();
      },
    });
    const s = this.socket;
    s.on('connect', () => {
      this.log(`✔ connected to ${this.cfg.server.url} as "${this.cfg.worker.name}" (fingerprint ${fingerprint(this.identity.publicKey)})`);
      if (!this.hb) this.hb = setInterval(() => this.heartbeat(), 10_000);
    });
    s.on('disconnect', (r) => this.log(`… disconnected (${r}), reconnecting`));
    s.on('connect_error', (e) => this.log(`… connect error: ${e.message}`));
    s.on('worker:approved', () => { this.approved = true; this.log('✔ this worker is APPROVED by the master app'); });
    s.on('server:error', (p: { message: string }) => this.log(`server: ${p.message}`));
    s.on('validation:request', (p) => void this.onValidation(p));
    s.on('worker:rescan-agents', () => void this.onRescan());
    s.on('worker:self-update', () => void this.onSelfUpdate());
    s.on('job:assigned', (job: JobPayload) => void this.onAssigned(job));
    s.on('job:stop-requested', (p: { runId: string; reason: string }) => {
      const j = this.jobs.get(p.runId);
      if (j) j.requestStop(p.reason);
      else this.socket.emit('job:stop-confirmed', { runId: p.runId, assignmentId: '', note: 'no active job on worker' });
    });
    s.on('approval:resolved', (p: { runId: string; stepId: string; approved: boolean }) => this.jobs.get(p.runId)?.resolveApproval(p.stepId, p.approved));
    if (!this.approved) this.log('… waiting for approval in the web app (Workers → Approve) if this is the first connection');
  }

  /** Requested from the web app: pull the new worker code, install, restart. Never while jobs are running. */
  private async onSelfUpdate() {
    const say = (state: 'updating' | 'restarting' | 'failed', message: string) => { this.log(message); this.socket.emit('worker:update-status', { state, message }); };
    if (this.updating) return;
    if (this.jobs.size > 0) return say('failed', `${this.jobs.size} job(s) are running - update again when they are done`);
    this.updating = true;
    this.heartbeat(); // 0 free slots from now on
    try {
      say('updating', 'Updating: git pull + npm install…');
      const dir = await installDir();
      const { before, after } = await pullAndInstall(dir, this.log);
      if (before === after) { this.updating = false; this.heartbeat(); return say('failed', `Already on the newest worker code in the repository (v${after}) - nothing changed`); }
      say('restarting', `Updated v${before} → v${after}, restarting…`);
      await new Promise((r) => setTimeout(r, 800)); // let the status reach the server
      this.stop();
      restartSelf(this.log);
    } catch (e) {
      this.updating = false;
      this.heartbeat();
      say('failed', `Update failed: ${(e as Error).message}`);
    }
  }

  /** Requested from the web app: look for newly installed agents, test them, report the result. */
  private async onRescan() {
    if (this.rescanning) return;
    this.rescanning = true;
    try {
      this.log('↻ rescanning agents (requested from the web app)…');
      this.cfg = await rescanAgents(this.cfg, this.log);
      if (this.cfgPath) saveConfig(this.cfgPath, this.cfg);
      this.log('↻ rescanning tools…');
      this.tools = await detectTools();
      this.socket.emit('worker:capabilities', { agents: agentInfos(this.cfg), tools: this.tools, maxConcurrentJobs: this.cfg.worker.maxConcurrentJobs });
    } catch (e) {
      this.log(`✘ rescan failed: ${(e as Error).message}`);
    } finally {
      this.rescanning = false;
    }
  }

  stop() {
    if (this.hb) clearInterval(this.hb);
    this.socket?.disconnect();
  }

  private freeSlots() {
    return this.updating ? 0 : Math.max(0, this.cfg.worker.maxConcurrentJobs - this.jobs.size); // no new jobs while updating
  }
  private heartbeat() {
    this.socket.emit('worker:heartbeat', { activeJobs: [...this.jobs.keys()], freeSlots: this.freeSlots() });
  }

  private link(): ServerLink {
    const s = () => this.socket;
    return {
      emit: (event, payload) => void s().emit(event, payload),
      call: <T,>(event: string, payload: unknown, timeoutMs = 20_000) =>
        new Promise<{ ok: boolean; data?: T; error?: string }>((resolve) => {
          if (!s().connected) return resolve({ ok: false, error: 'offline' });
          s().timeout(timeoutMs).emit(event, payload, (err: Error | null, res: { ok: boolean; data?: T; error?: string }) => resolve(err ? { ok: false, error: 'timeout' } : res));
        }),
      sendLogs: (runId: string, chunks: LogChunk[]) =>
        new Promise((resolve) => {
          if (!s().connected) return resolve(false);
          s().timeout(8000).emit('log:chunk', { runId, chunks }, (err: Error | null, res?: { ok: boolean }) => resolve(!err && !!res?.ok));
        }),
    };
  }

  private async onAssigned(job: JobPayload) {
    if (this.jobs.has(job.runId)) return; // idempotent: never run a job twice
    if (this.freeSlots() === 0) {
      this.socket.emit('job:rejected', { runId: job.runId, assignmentId: job.assignmentId, reason: 'no free slot' });
      return;
    }
    const missing = job.workflow.steps.map((s) => s.resolvedAgentKey).filter((k): k is string => !!k).filter((k) => !this.cfg.agents[k] || this.cfg.agents[k].available === false);
    if (missing.length) {
      this.socket.emit('job:rejected', { runId: job.runId, assignmentId: job.assignmentId, reason: `agent(s) not available: ${[...new Set(missing)].join(', ')}` });
      return;
    }
    // host tools are checked again right now (the scheduler matched them against the last report); workspace tools are checked by the job in its real environment
    const hostTools = schedulingToolIds(job.workflow, true);
    if (hostTools.length) {
      const now = await detectTools(undefined, hostTools);
      const lacking = missingTools(hostTools, now.filter((t) => t.available).map((t) => t.id));
      if (lacking.length) {
        this.tools = [...this.tools.filter((t) => !hostTools.includes(t.id)), ...now];
        this.socket.emit('job:rejected', { runId: job.runId, assignmentId: job.assignmentId, reason: `tool(s) not available on this worker: ${describeMissing(lacking)}` });
        this.socket.emit('worker:capabilities', { agents: agentInfos(this.cfg), tools: this.tools, maxConcurrentJobs: this.cfg.worker.maxConcurrentJobs });
        return;
      }
    }
    const runner = new JobRunner(job, this.cfg, this.link(), this.podman);
    this.jobs.set(job.runId, runner);
    const ack = await this.link().call('job:accepted', { runId: job.runId, assignmentId: job.assignmentId });
    if (!ack.ok) {
      this.log(`✘ master refused ${job.ticket.key}: ${ack.error}`);
      this.jobs.delete(job.runId);
      return;
    }
    this.log(`▶ job ${job.ticket.key} (${job.runId}) accepted - ${this.jobs.size}/${this.cfg.worker.maxConcurrentJobs} slots busy`);
    this.socket.emit('worker:status', { freeSlots: this.freeSlots(), activeJobs: [...this.jobs.keys()] });
    void runner.run().finally(() => {
      this.jobs.delete(job.runId);
      this.log(`■ job ${job.ticket.key} finished`);
      this.socket.emit('worker:status', { freeSlots: this.freeSlots(), activeJobs: [...this.jobs.keys()] });
    });
  }

  private async onValidation(p: Parameters<typeof validateProject>[0]) {
    this.log(`… checking repository access for request ${p.requestId}`);
    const result = await validateProject(p);
    this.socket.emit('validation:result', { requestId: p.requestId, result });
    this.log(`${result.ok ? '✔' : '✘'} validation: ${result.message}`);
  }
}
