import { hostname, platform } from 'node:os';
import { io, type Socket } from 'socket.io-client';
import { fingerprint, signChallenge, type WorkerIdentity } from '@nova/shared/identity';
import type { JobPayload, LogChunk, WorkerAgentInfo, WorkerAuthPayload, WorkerHealth, WorkerHello } from '@nova/shared';
import { adapterFor } from './agents/adapters.js';
import type { WorkerConfig } from './config.js';
import { JobRunner, type ServerLink } from './jobRunner.js';
import { Podman } from './podman.js';
import { formatPreflight, runPreflight } from './preflight.js';
import { validateProject } from './validate.js';

const VERSION = '0.1.0';

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
  private podman: Podman;

  constructor(private cfg: WorkerConfig, private identity: WorkerIdentity, private log: (m: string) => void = console.log) {
    this.podman = new Podman(cfg.podman.command);
  }

  private serverHttp() {
    return this.cfg.server.url.replace(/^ws/, 'http').replace(/\/$/, '');
  }

  private hello(): WorkerHello {
    return {
      fingerprint: fingerprint(this.identity.publicKey), publicKey: this.identity.publicKey, name: this.cfg.worker.name, hostname: hostname(), platform: platform(),
      maxConcurrentJobs: this.cfg.worker.maxConcurrentJobs, agents: agentInfos(this.cfg), activeJobs: [...this.jobs.keys()], version: VERSION, health: this.health,
    };
  }

  /** Active connect (worker -> master). Each (re)connect fetches a fresh challenge and signs it with the durable identity. */
  async start() {
    // One-time tool check; the result is sent to the master app in every (re)connect handshake.
    this.health = await runPreflight(this.cfg);
    this.log('Tool check:');
    for (const l of formatPreflight(this.health)) this.log(l);
    const missing = this.health.checks.filter((c) => !c.ok);
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
    s.on('job:assigned', (job: JobPayload) => void this.onAssigned(job));
    s.on('job:stop-requested', (p: { runId: string; reason: string }) => {
      const j = this.jobs.get(p.runId);
      if (j) j.requestStop(p.reason);
      else this.socket.emit('job:stop-confirmed', { runId: p.runId, assignmentId: '', note: 'no active job on worker' });
    });
    s.on('approval:resolved', (p: { runId: string; stepId: string; approved: boolean }) => this.jobs.get(p.runId)?.resolveApproval(p.stepId, p.approved));
    if (!this.approved) this.log('… waiting for approval in the web app (Workers → Approve) if this is the first connection');
  }

  stop() {
    if (this.hb) clearInterval(this.hb);
    this.socket?.disconnect();
  }

  private freeSlots() {
    return Math.max(0, this.cfg.worker.maxConcurrentJobs - this.jobs.size);
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
    this.log(`… validating Dockerfile for request ${p.requestId}`);
    const result = await validateProject(p, this.podman, this.cfg);
    this.socket.emit('validation:result', { requestId: p.requestId, result });
    this.log(`${result.ok ? '✔' : '✘'} validation: ${result.message}`);
  }
}
