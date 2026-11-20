import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  extractJsonFromText, extractMetrics, extractObservation, makeRedactor, validateOutput,
  type ErrorKind, type JobPayload, type ResolvedStep, type StepResultPayload,
} from '@nova/shared';
import { runWorkflow, type FailureFeedback, type StepExecutor, type StepOutcome } from '@nova/workflow-engine';
import { adapterFor, shq } from './agents/adapters.js';
import type { AgentEntry, WorkerConfig } from './config.js';
import { workspacesDir } from './config.js';
import { Git, GitError, isConflict, mirrorDir } from './git.js';
import { LogSink, type StepSink } from './logSink.js';
import { Podman } from './podman.js';
import { buildPrompt, mockResult } from './prompt.js';
import { run as runProc, withPath } from './proc.js';

export interface ServerLink {
  emit(event: string, payload: unknown): void;
  /** request/response with ack */
  call<T = unknown>(event: string, payload: unknown, timeoutMs?: number): Promise<{ ok: boolean; data?: T; error?: string }>;
  sendLogs(runId: string, chunks: import('@nova/shared').LogChunk[]): Promise<boolean>;
}

const AUTH_RE = /(not logged in|please run .*login|invalid api key|authentication (failed|error)|unauthorized|401|no api key|missing .*api.?key)/i;

export class JobRunner {
  private stopReason: string | null = null;
  private abort = new AbortController();
  private currentStep: string | null = null;
  private approvals = new Map<string, (approved: boolean) => void>();
  private container: string;
  private image: string;
  private workspace: string;
  private git: Git;
  private sink: LogSink;
  private startedAt = new Map<string, string>();
  private meta = new Map<string, { exitCode?: number | null; agentKey?: string | null }>();
  private installed = new Set<string>();
  private installing = new Map<string, Promise<string | null>>();
  private branchPushed = false;
  /** false when the repo has no Dockerfile: everything runs directly on the worker host */
  private containerized: boolean;

  constructor(private job: JobPayload, private cfg: WorkerConfig, private link: ServerLink, private podman: Podman) {
    this.containerized = !!job.repo.dockerfilePath;
    this.container = `nova-${job.runId.slice(-12)}`;
    this.image = `nova-job-${job.runId.slice(-12)}:latest`;
    this.workspace = join(workspacesDir(), job.runId);
    const redact = makeRedactor([job.repo.authToken ?? '', process.env.OPENAI_API_KEY ?? '', process.env.ANTHROPIC_API_KEY ?? '']);
    this.sink = new LogSink(job.runId, redact, (c) => link.sendLogs(job.runId, c), () => this.currentStep);
    this.git = new Git(this.workspace, { user: job.repo.authUser, token: job.repo.authToken }, (s) => this.sink.system(s, 'warn'));
  }

  /** How many steps this worker runs at the same time: its own setting, but never more than the CPUs of the job container. */
  private parallelLimit() {
    const cpus = Math.floor(Number(this.cfg.podman.cpus)) || 1;
    return Math.max(1, Math.min(this.cfg.worker.maxParallelSteps ?? 2, cpus));
  }

  get runId() { return this.job.runId; }
  get stopRequested() { return this.stopReason !== null; }

  requestStop(reason: string) {
    if (this.stopReason !== null) return;
    this.stopReason = reason || 'stop requested';
    this.sink.system(`Stop requested: ${this.stopReason}`, 'warn');
    this.abort.abort();
    for (const cb of this.approvals.values()) cb(false);
  }
  resolveApproval(stepId: string, approved: boolean) {
    this.approvals.get(stepId)?.(approved);
  }

  /** Full ticket lifecycle on this worker. Always ends with exactly one terminal event. */
  async run(): Promise<void> {
    const { job } = this;
    const sys = (m: string, l: 'info' | 'warn' | 'error' = 'info') => this.sink.system(m, l);
    try {
      sys(`Starting job for ${job.ticket.key}${job.isTest ? ' [TEST RUN: no push, no PR, no Jira changes]' : ''} on branch ${job.repo.branch}`);
      if (this.containerized) {
        const pm = await this.podman.available();
        if (!pm.ok) { this.containerized = false; sys(`Container runtime unavailable (${pm.message}): running directly on the worker host (no container isolation)`, 'warn'); }
      }

      // 1+2) clone, branch
      this.link.emit('job:phase', { runId: job.runId, phase: 'Cloning repository', detail: job.repo.cloneUrl });
      sys(`Cloning ${job.repo.mock ? '(MOCK remote) ' : ''}repository…`);
      try {
        rmSync(this.workspace, { recursive: true, force: true });
        const tick = setInterval(() => {
          execFile('du', ['-sk', this.workspace, mirrorDir(job.repo.cloneUrl)], (_err, out) => {
            const kb = (out ?? '').split('\n').reduce((n, l) => n + (Number(l.split('\t')[0]) || 0), 0);
            if (!kb) return;
            this.link.emit('job:phase', { runId: job.runId, phase: 'Cloning repository', detail: `${kb >= 1048576 ? (kb / 1048576).toFixed(2) + ' GB' : Math.round(kb / 1024) + ' MB'} on disk`, progress: true });
          });
        }, 3000);
        try { await this.git.clone(job.repo.cloneUrl, job.repo.branch, job.repo.baseBranch ?? job.repo.defaultBranch, workspacesDir(), job.runId); } finally { clearInterval(tick); }
      } catch (e) {
        return await this.fail('GITHUB_UNREACHABLE', (e as Error).message);
      }
      mkdirSync(join(this.workspace, '.nova'), { recursive: true });
      if (this.containerized && !existsSync(join(this.workspace, job.repo.dockerfilePath!))) this.containerized = false; // announced below
      if (this.stopRequested) return await this.finishStopped();

      // 3) image + container (only when the repo has a Dockerfile)
      if (!this.containerized) {
        this.link.emit('job:phase', { runId: job.runId, phase: 'Using worker host', detail: 'no container' });
        sys('No Dockerfile in the repository (or no container runtime): running directly on the worker host (no container isolation)', 'warn');
        this.link.emit('job:started', { runId: job.runId, assignmentId: job.assignmentId, containerId: null });
      } else {
        this.link.emit('job:phase', { runId: job.runId, phase: 'Building project image', detail: 'podman build from Dockerfile' });
        sys('Building project image from Dockerfile…');
        const b = await this.podman.build(this.image, this.workspace, job.repo.dockerfilePath!, { signal: this.abort.signal, timeoutMs: 15 * 60_000, onStdout: (s) => this.sink.write('stdout', s), onStderr: (s) => this.sink.write('stderr', s) });
        if (this.stopRequested) return await this.finishStopped();
        if (b.code !== 0) return await this.fail('CONTAINER_BUILD', `podman build failed (exit ${b.code})`);
        this.link.emit('job:phase', { runId: job.runId, phase: 'Starting container' });
        const mounts = this.agentMounts();
        const st = await this.podman.start(this.container, this.image, this.workspace, { memory: this.cfg.podman.memory, cpus: this.cfg.podman.cpus, pids: this.cfg.podman.pids }, mounts);
        if (st.code !== 0) {
          const hint = /statfs|no such file|permission denied|mount/i.test(st.stderr) ? ` Hint: the workspace dir (${workspacesDir()}) must be inside a path shared with the Podman machine (on macOS e.g. below /Users; /tmp is NOT shared). Set NOVA_WORKER_HOME accordingly.` : '';
          return await this.fail('CONTAINER_BUILD', `could not start container: ${st.stderr.trim().slice(-300)}${hint}`);
        }
        sys(`Container ${this.container} running (unprivileged, caps dropped, ${this.cfg.podman.memory} / ${this.cfg.podman.cpus} cpus)`);
        this.link.emit('job:started', { runId: job.runId, assignmentId: job.assignmentId, containerId: this.container });
      }

      // 4) workflow: groups in order; steps of a group run in dependency order, as many at once as THIS worker allows
      const parallel = this.parallelLimit();
      sys(`Steps run ${parallel > 1 ? `up to ${parallel} at a time when they have no open dependencies` : 'one after the other'} (worker setting, limited by the container CPUs)`);
      const executor: StepExecutor = { execute: (step, c) => this.executeStep(step, c.attempt, c.feedback) };
      const result = await runWorkflow(job.workflow, executor, {
        onStepStart: (s, attempt) => {
          const at = new Date().toISOString();
          this.startedAt.set(`${s.id}#${attempt}`, at);
          this.currentStep = s.id;
          this.link.emit('step:started', { runId: job.runId, stepId: s.id, attempt, agentKey: s.resolvedAgentKey, startedAt: at });
          this.sink.forStep(s.id).system(`▶ ${s.groupName} / ${s.name}${s.resolvedAgentKey ? ` (agent: ${s.resolvedAgentKey}, ${s.agentSource})` : ''}`);
        },
        onLoop: async (from, to, fb) => {
          sys(`↩ ${fb.fromGroup ? `Group "${fb.fromGroup}"` : from.name} ${fb.reason === 'rework' ? 'reports findings' : 'failed'} (${fb.message.slice(0, 200).replace(/\n/g, ' | ')}) - going back to "${to.name}" (loop ${fb.loop}/${fb.maxLoops})`, 'warn');
          await this.call('step:loop', { runId: job.runId, fromStepId: from.id, toStepId: to.id, fromGroup: fb.fromGroup ?? null, loop: fb.loop, maxLoops: fb.maxLoops, reason: fb.reason, message: fb.message });
        },
        onStepEnd: async (s, o, attempt) => {
          const payload = this.stepPayload(s, o, attempt);
          this.sink.forStep(s.id).system(`${o.status === 'COMPLETED' ? '✔' : '✘'} ${s.name}: ${o.status}${o.status === 'FAILED' ? ` - ${o.message}` : ''}`, o.status === 'FAILED' ? 'error' : 'info');
          await this.call(o.status === 'COMPLETED' ? 'step:completed' : 'step:failed', payload);
        },
      }, { isStopRequested: () => this.stopRequested, maxRetriesCap: this.job.retry.technicalRetries, maxParallel: parallel });

      if (result.status === 'STOPPED' || this.stopRequested) return await this.finishStopped();
      if (result.status === 'FAILED') return await this.fail(result.failure!.kind, result.failure!.message, result.failedStepId);
      this.currentStep = null;
      sys('Workflow completed successfully');
      await this.sink.drain();
      await this.call('job:completed', { runId: job.runId, assignmentId: job.assignmentId, branch: job.repo.branch, summary: '' });
      await this.cleanup(true);
    } catch (e) {
      if (this.stopRequested) return await this.finishStopped();
      await this.fail('INTERNAL', (e as Error).message);
    }
  }

  // ───────────────── step execution ─────────────────
  private stepPayload(s: ResolvedStep, o: StepOutcome, attempt: number): StepResultPayload {
    const m = this.meta.get(s.id) ?? {};
    return {
      runId: this.job.runId, stepId: s.id, attempt, status: o.status === 'COMPLETED' ? 'COMPLETED' : o.status === 'STOPPED' ? 'STOPPED' : 'FAILED',
      startedAt: this.startedAt.get(`${s.id}#${attempt}`) ?? new Date().toISOString(), endedAt: new Date().toISOString(), agentKey: s.resolvedAgentKey,
      // a failed step may still carry its output (shell tail, a result that failed its check): it is stored and becomes loop feedback
      output: o.status === 'STOPPED' ? null : o.output ?? null, metrics: o.status === 'STOPPED' ? {} : o.metrics ?? {}, observation: o.status === 'STOPPED' ? null : o.observation ?? null,
      error: o.status === 'FAILED' ? { kind: o.kind, message: o.message } : null, exitCode: m.exitCode ?? null,
    };
  }

  private async executeStep(step: ResolvedStep, attempt: number, feedback?: FailureFeedback): Promise<StepOutcome> {
    if (this.stopRequested) return { status: 'STOPPED' };
    switch (step.type) {
      case 'AI_PROMPT': return this.aiStep(step, attempt, feedback);
      case 'KOAN_BOT': return this.koanStep(step);
      case 'SHELL': return this.shellStep(step);
      case 'HUMAN_APPROVAL': return this.approvalStep(step);
      case 'PULL_REQUEST': return this.prStep(step);
    }
  }

  private agentEntry(key: string): AgentEntry | null {
    const e = this.cfg.agents[key];
    return e && e.enabled && e.available !== false ? e : null;
  }

  private agentMounts(): string[] {
    const m = new Set<string>();
    for (const s of this.job.workflow.steps) {
      const e = s.resolvedAgentKey ? this.cfg.agents[s.resolvedAgentKey] : null;
      if (e && (e.runtime ?? 'container') === 'container') for (const x of e.container?.mounts ?? []) m.add(x.replace(/^~/, process.env.HOME ?? '~'));
    }
    return [...m];
  }

  /** Steps run in parallel: the first one installs the agent CLI, the others wait for the same result. */
  private ensureAgentInContainer(key: string, e: AgentEntry, sink: StepSink): Promise<string | null> {
    let p = this.installing.get(key);
    if (!p) { p = this.installAgent(key, e, sink); this.installing.set(key, p); void p.finally(() => this.installing.delete(key)); }
    return p;
  }

  private async installAgent(key: string, e: AgentEntry, sink: StepSink): Promise<string | null> {
    if (this.installed.has(key)) return null;
    const ad = adapterFor(key, e);
    if (ad.kind === 'mock') { this.installed.add(key); return null; }
    if (await this.podman.has(this.container, e.command)) { this.installed.add(key); return null; }
    const install = e.container?.install ?? ad.defaultInstall;
    if (!install) return `Agent CLI "${e.command}" is not available inside the project image and no container.install is configured`;
    sink.system(`Installing ${key} CLI inside the job container: ${install}`);
    const r = await this.podman.sh(this.container, install, { signal: this.abort.signal, timeoutMs: 10 * 60_000, onStdout: (s) => sink.write('stdout', s), onStderr: (s) => sink.write('stderr', s) });
    if (r.code !== 0) return `Could not install ${key} in the container (exit ${r.code}). Install it in the project Dockerfile, configure container.install, or set runtime: host.`;
    this.installed.add(key);
    return null;
  }

  private writeSkills(step: ResolvedStep, kind: string) {
    const skills = this.job.skills.filter((s) => step.skills.some((r) => r.id === s.id));
    for (const s of skills) {
      const safe = s.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const dirs = [join('.nova', 'skills', safe)];
      if (kind === 'claude') dirs.push(join('.claude', 'skills', safe));
      if (kind === 'codex') dirs.push(join('.agents', 'skills', safe));
      for (const d of dirs) {
        const abs = join(this.workspace, d);
        if (existsSync(join(abs, 'SKILL.md'))) continue; // never overwrite repo skills
        mkdirSync(abs, { recursive: true });
        writeFileSync(join(abs, 'SKILL.md'), s.content);
        if (!d.startsWith('.nova')) this.git.exclude(`${d}/`);
      }
    }
  }

  private async aiStep(step: ResolvedStep, attempt: number, feedback?: FailureFeedback): Promise<StepOutcome> {
    const sink = this.sink.forStep(step.id);
    const key = step.resolvedAgentKey!;
    const entry = this.agentEntry(key);
    this.meta.set(step.id, { agentKey: key });
    if (!entry) return { status: 'FAILED', kind: 'AGENT_UNAVAILABLE', message: `Agent "${key}" is not available on this worker`, technical: false };
    const ad = adapterFor(key, entry);
    const runtime = this.containerized ? entry.runtime ?? 'container' : 'host';
    if (runtime === 'container') {
      const err = await this.ensureAgentInContainer(key, entry, sink);
      if (err) return { status: 'FAILED', kind: 'AGENT_UNAVAILABLE', message: err, technical: false };
    } else sink.system(this.containerized ? `⚠ Agent "${key}" runs on the HOST (runtime: host). Project commands still run in the container.` : `⚠ Agent "${key}" runs on the HOST (project has no Dockerfile).`, 'warn');
    this.writeSkills(step, ad.kind);

    const resultRel = `.nova/result-${step.id}.json`;
    const hostResult = join(this.workspace, resultRel);
    const resultInRuntime = runtime === 'container' ? `/workspace/${resultRel}` : hostResult;
    let correction: string[] | undefined;
    const maxCorrections = this.job.retry.jsonCorrectionAttempts;

    for (let round = 0; round <= maxCorrections; round++) {
      rmSync(hostResult, { force: true });
      const prompt = buildPrompt(this.job, step, this.job.skills, resultInRuntime, correction, feedback);
      const inv = ad.build(entry, { prompt, runtime, workspace: this.workspace, resultPath: resultInRuntime, mockResultJson: mockResult(step.expectedOutputs) });
      sink.system(`Running ${key} (${runtime})${correction ? ' - correction attempt' : ''}…`);
      const onOut = (s: string) => sink.write('stdout', s);
      const onErr = (s: string) => sink.write('stderr', s);
      const common = { signal: this.abort.signal, timeoutMs: step.timeoutSec * 1000, onStdout: onOut, onStderr: onErr, stdin: inv.stdin };
      const r = runtime === 'container'
        ? await this.podman.exec(this.container, [inv.cmd, ...inv.args], { ...common, passEnv: entry.container?.env ?? ad.defaultEnv })
        : await runProc(inv.cmd, inv.args, { ...common, cwd: this.workspace, env: withPath() });
      this.meta.set(step.id, { agentKey: key, exitCode: r.code });
      if (r.aborted || this.stopRequested) return { status: 'STOPPED' };
      if (r.timedOut) return { status: 'FAILED', kind: 'AGENT_TIMEOUT', message: `Agent did not finish within ${step.timeoutSec}s`, technical: true };
      if (r.code !== 0) {
        const tail = `${r.stderr}\n${r.stdout}`.slice(-1500);
        if (AUTH_RE.test(tail)) return { status: 'FAILED', kind: 'AGENT_AUTH', message: `Agent CLI authentication failed. ${runtime === 'container' ? 'Pass credentials via agents.<key>.container.env/mounts in worker.config.yaml.' : 'Run the CLI login on the host.'}`, technical: false };
        return { status: 'FAILED', kind: 'AGENT_UNAVAILABLE', message: `Agent exited with code ${r.code}: ${tail.trim().split('\n').slice(-2).join(' | ').slice(0, 300)}`, technical: attempt === 1 };
      }
      // structured JSON is separated from free terminal output
      let raw: string | null = null;
      if (existsSync(hostResult)) raw = readFileSync(hostResult, 'utf8');
      else raw = extractJsonFromText(r.stdout);
      if (raw === null) {
        correction = ['No JSON result found. Write the JSON object to the result file.'];
      } else {
        const v = validateOutput(raw, step.expectedOutputs);
        if (v.ok) {
          return { status: 'COMPLETED', output: v.data!, metrics: extractMetrics(v.data!, step.expectedOutputs), observation: extractObservation(v.data!) };
        }
        correction = v.errors;
      }
      sink.system(`Result JSON invalid: ${correction.join('; ')}`, 'warn');
    }
    return { status: 'FAILED', kind: 'INVALID_JSON', message: `Invalid result JSON after ${maxCorrections + 1} attempt(s): ${correction?.join('; ')}`, technical: false };
  }

  /**
   * Kōan Bot step. The real integration (CLI/API of the koan-bot instance) is not wired yet: for now the step runs against a
   * mock that logs the command and reports a clean result, so workflows with Kōan steps can be built and tested end to end.
   */
  private async koanStep(step: ResolvedStep): Promise<StepOutcome> {
    const sink = this.sink.forStep(step.id);
    const command = step.koanCommand;
    this.meta.set(step.id, { agentKey: 'koan' });
    sink.system(`🥷 Kōan /${command} ${step.prompt.trim()}`);
    sink.system('Kōan integration is mocked: no real bot was called.', 'warn');
    if (this.abort.signal.aborted || this.stopRequested) return { status: 'STOPPED' };
    return { status: 'COMPLETED', output: { koan_command: command, task: step.prompt.trim(), mocked: true, needs_rework: false }, metrics: {} };
  }

  private async shellStep(step: ResolvedStep): Promise<StepOutcome> {
    const sink = this.sink.forStep(step.id);
    sink.system(`$ ${step.command}`);
    const shellOpts = { signal: this.abort.signal, timeoutMs: step.timeoutSec * 1000, onStdout: (s: string) => sink.write('stdout', s), onStderr: (s: string) => sink.write('stderr', s) };
    const r = this.containerized
      ? await this.podman.sh(this.container, step.command, shellOpts)
      : await runProc('sh', ['-lc', step.command], { ...shellOpts, cwd: this.workspace, env: withPath() });
    this.meta.set(step.id, { exitCode: r.code });
    if (r.aborted || this.stopRequested) return { status: 'STOPPED' };
    if (r.timedOut) return { status: 'FAILED', kind: 'TIMEOUT', message: `Command timed out after ${step.timeoutSec}s`, technical: true };
    const tail = `${r.stdout}${r.stderr}`.trim().split('\n').slice(-20).join('\n');
    if (r.code !== 0) return { status: 'FAILED', kind: 'COMMAND_FAILED', message: `Command exited with code ${r.code}`, technical: false, output: { exit_code: r.code, output_tail: tail } };
    return { status: 'COMPLETED', output: { exit_code: 0, output_tail: tail }, metrics: {} };
  }

  private async approvalStep(step: ResolvedStep): Promise<StepOutcome> {
    const sink = this.sink.forStep(step.id);
    sink.system('⏸ Waiting for human approval…');
    const waiting = new Promise<boolean>((res) => this.approvals.set(step.id, res));
    await this.call('step:awaiting-approval', { runId: this.job.runId, stepId: step.id });
    const approved = await waiting;
    this.approvals.delete(step.id);
    if (this.stopRequested) return { status: 'STOPPED' };
    return approved ? { status: 'COMPLETED', output: { approved: true } } : { status: 'FAILED', kind: 'INTERNAL', message: 'Approval rejected', technical: false };
  }

  private async prStep(step: ResolvedStep): Promise<StepOutcome> {
    const sink = this.sink.forStep(step.id);
    if (this.job.isTest) return { status: 'FAILED', kind: 'INTERNAL', message: 'PR steps never run in test mode', technical: false };
    const { branch } = this.job.repo;
    try {
      const committed = await this.git.commitAll(`${this.job.ticket.key}: ${this.job.ticket.title}\n\nCreated by Nova Factory run ${this.job.runId}`);
      sink.system(committed ? 'Committed changes' : 'No new working-tree changes (using existing commits)');
      await this.git.push(branch);
      this.branchPushed = true;
      sink.system(`Pushed branch ${branch}`);
    } catch (e) {
      return { status: 'FAILED', kind: isConflict(e) ? 'GIT_CONFLICT' : e instanceof GitError && e.op === 'push' ? 'GITHUB_UNREACHABLE' : 'COMMAND_FAILED', message: (e as Error).message, technical: false };
    }
    let res = await this.link.call<{ url?: string; number?: number; delegate?: { title: string; body: string; base: string } }>('pr:create', { runId: this.job.runId, branch, summary: '' }, 60_000);
    if (!res.ok) return { status: 'FAILED', kind: 'GITHUB_UNREACHABLE', message: `Pull request creation failed: ${res.error}`, technical: true };
    if (res.data?.delegate) {
      // real GitHub: this worker creates the PR with its own credentials, then registers it
      try {
        const pr = await this.git.createPullRequest({ branch, ...res.data.delegate });
        res = await this.link.call('pr:register', { runId: this.job.runId, branch, ...pr }, 30_000);
      } catch (e) {
        return { status: 'FAILED', kind: 'GITHUB_UNREACHABLE', message: `Pull request creation failed: ${(e as Error).message}`, technical: false };
      }
      if (!res.ok) return { status: 'FAILED', kind: 'GITHUB_UNREACHABLE', message: `Pull request registration failed: ${res.error}`, technical: true };
    }
    sink.system(`Pull request #${res.data!.number}: ${res.data!.url}`);
    return { status: 'COMPLETED', output: { pr_url: res.data!.url, pr_number: res.data!.number } };
  }

  // ───────────────── terminal states ─────────────────
  private call(event: string, payload: unknown) {
    return this.link.call(event, payload, 20_000).catch(() => ({ ok: false }));
  }

  private async fail(kind: ErrorKind, message: string, stepId?: string | null) {
    this.sink.system(`Job failed (${kind}): ${message}`, 'error');
    await this.preserveWork();
    await this.sink.drain();
    await this.call('job:failed', { runId: this.job.runId, assignmentId: this.job.assignmentId, stepId: stepId ?? null, kind, message });
    await this.cleanup(false);
  }

  private async finishStopped() {
    this.sink.system(this.containerized ? 'Stopping: terminating agent processes and container…' : 'Stopping: terminating agent processes…', 'warn');
    if (this.containerized) {
      await this.podman.stop(this.container, 5).catch(() => undefined);
      await this.podman.kill(this.container).catch(() => undefined); // force if still alive
    }
    await this.preserveWork();
    await this.sink.drain();
    await this.call('job:stop-confirmed', { runId: this.job.runId, assignmentId: this.job.assignmentId, note: this.stopReason ?? undefined });
    await this.cleanup(false);
  }

  /** WIP commit so partial work survives; the branch is never deleted. Test runs keep nothing. */
  private async preserveWork() {
    if (this.job.isTest || !existsSync(join(this.workspace, '.git'))) return;
    try {
      if (await this.git.commitAll(`WIP: ${this.job.ticket.key} (Nova Factory run ${this.job.runId}, interrupted)`)) {
        this.sink.system('Saved work-in-progress commit on the ticket branch');
        await this.git.push(this.job.repo.branch).catch(() => this.sink.system('WIP push skipped (remote unreachable); workspace kept on worker', 'warn'));
      }
    } catch (e) {
      this.sink.system(`Could not preserve work: ${(e as Error).message}`, 'warn');
    }
  }

  private async cleanup(success: boolean) {
    if (this.containerized) {
      await this.podman.rm(this.container).catch(() => undefined);
      await this.podman.rmi(this.image).catch(() => undefined);
    }
    // keep the workspace of failed/stopped jobs for inspection; remove after success and for tests
    if (success || this.job.isTest) rmSync(this.workspace, { recursive: true, force: true });
    void this.branchPushed;
    void shq;
  }
}
