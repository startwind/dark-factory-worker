import { extractRework, stepDependencies, type ErrorKind, type ResolvedGroup, type ResolvedStep, type ResolvedWorkflow, type SendBack } from '@nova/shared';

export type StepOutcome =
  | { status: 'COMPLETED'; output?: Record<string, unknown> | null; metrics?: Record<string, number>; observation?: string | null }
  | {
      status: 'FAILED'; kind: ErrorKind; message: string; /** technical errors may be retried, functional ones halt */ technical: boolean;
      /** what the step produced before failing (shell tail, AI result of a failed check, ...): becomes the feedback of a loop */
      output?: Record<string, unknown> | null; metrics?: Record<string, number>; observation?: string | null;
    }
  | { status: 'STOPPED' };

/** What one step found (reported findings or a failure); several of these make up the feedback of a group's send back. */
export interface FeedbackSource {
  stepId: string;
  stepName: string;
  /** `rework`: the step succeeded but reported findings (needs_rework); `failure`: the step failed (e.g. tests) */
  reason: 'rework' | 'failure';
  message: string;
  /** the step's result JSON (findings) or the shell tail */
  output: Record<string, unknown> | null;
}

/** Why the workflow was sent back to an earlier step; handed to the AI step(s) we go back to as context. */
export interface FailureFeedback {
  /** the step that sent the workflow back, or - for a group's send back - the group's last step */
  fromStepId: string;
  /** step name, or the group name for a group's send back */
  fromStepName: string;
  /** set when the whole group sent the workflow back (after ALL its steps ran) */
  fromGroup?: string | null;
  /** 1-based number of this loop for the sender (step or group) */
  loop: number;
  maxLoops: number;
  /** `failure` if any source failed hard, else `rework` */
  reason: 'rework' | 'failure';
  message: string;
  output: Record<string, unknown> | null;
  /** every step that contributed (one for a step's send back, one per affected step for a group's) */
  sources: FeedbackSource[];
}

export interface StepExecutor {
  /** `attempt` = technical retry number within this execution; `feedback` is set when the step runs again because a later step/group found problems */
  execute(step: ResolvedStep, ctx: { attempt: number; feedback?: FailureFeedback }): Promise<StepOutcome>;
}

export interface EngineHooks {
  onGroupStart?(group: ResolvedGroup): Promise<void> | void;
  onGroupEnd?(group: ResolvedGroup): Promise<void> | void;
  /** `attempt` counts every execution of the step across loops, so it never repeats within a run */
  onStepStart?(step: ResolvedStep, attempt: number): Promise<void> | void;
  onStepEnd?(step: ResolvedStep, outcome: StepOutcome, attempt: number): Promise<void> | void;
  /** `from` found problems (for a group: its last step); the workflow continues at `to` (the first step we go back to) */
  onLoop?(from: ResolvedStep, to: ResolvedStep, feedback: FailureFeedback): Promise<void> | void;
}

export interface EngineResult {
  status: 'COMPLETED' | 'FAILED' | 'STOPPED';
  failedStepId?: string;
  failure?: { kind: ErrorKind; message: string };
  completedSteps: string[];
}

export interface EngineOptions {
  isStopRequested?: () => boolean;
  /** Global safety cap for retries per step, regardless of config. */
  maxRetriesCap?: number;
  /** Global safety cap for loops (jumps back) in one run, regardless of per-step maxLoops. */
  maxTotalLoops?: number;
  /**
   * How many steps the executor may run at the same time. The WORKER decides (1 = strictly one after the other).
   * Only steps whose dependencies are done can run in parallel; waiting for a human approval does not count.
   */
  maxParallel?: number;
  startIndex?: number;
}

const plural = (n: number) => `${n} loop${n === 1 ? '' : 's'}`;

/** How a pass through one group ended. */
type PhaseResult =
  | { kind: 'done' }
  | { kind: 'stopped'; stepId?: string }
  | { kind: 'fail'; stepId: string; kind2: ErrorKind; message: string }
  | { kind: 'jump'; from: ResolvedStep; target: { index: number; ids: string[] }; fb: FailureFeedback };

/**
 * Workflow engine. Groups are sequential phases. WITHIN a group the steps form a dependency graph (`dependsOn`; unset = after
 * the previous step): steps whose dependencies are done may run at the same time, as many as `maxParallel` allows.
 * Technical failures are retried a bounded number of times.
 *
 * "Send back": a step that reports findings (`needs_rework`, it still SUCCEEDS) or fails can send the workflow BACK to an
 * earlier step or group (`sendBack`), bounded by `maxLoops`, passing its output along as feedback.
 * A GROUP can have the same route: then ALL its steps run first (a step with findings/failure does not interrupt it),
 * and at the end of the group the findings of all steps are sent back together.
 * When a step sends the workflow back or stops it while others are still running, no new step is started and the running ones
 * are awaited first.
 */
export async function runWorkflow(
  wf: ResolvedWorkflow,
  executor: StepExecutor,
  hooks: EngineHooks = {},
  opts: EngineOptions = {},
): Promise<EngineResult> {
  const cap = opts.maxRetriesCap ?? 3;
  const loopCap = opts.maxTotalLoops ?? 25;
  const limit = Math.max(1, Math.floor(opts.maxParallel ?? 1));
  let currentGroup: string | null = null;
  const groupOf = (id: string) => wf.groups.find((g) => g.id === id)!;

  const steps = wf.steps.slice(opts.startIndex ?? 0);
  const indexOf = new Map(steps.map((s, i) => [s.id, i]));
  const firstIdx = new Map<string, number>(); // first / last step index per group (steps of a group are contiguous)
  const lastIdx = new Map<string, number>();
  steps.forEach((s, i) => { if (!firstIdx.has(s.groupId)) firstIdx.set(s.groupId, i); lastIdx.set(s.groupId, i); });
  const groupOrder = [...firstIdx.keys()];

  /** Where does a route lead? `index` = step to continue at; `ids` = the AI steps that get the feedback. */
  const targetOf = (route?: SendBack | null): { index: number; ids: string[]; name: string } | undefined => {
    if (route?.goToStepId) {
      const t = indexOf.get(route.goToStepId);
      return t === undefined ? undefined : { index: t, ids: [route.goToStepId], name: steps[t].name };
    }
    if (route?.goToGroupId) {
      const f = firstIdx.get(route.goToGroupId);
      if (f === undefined) return undefined;
      const l = lastIdx.get(route.goToGroupId)!;
      return { index: f, ids: steps.slice(f, l + 1).filter((s) => s.type === 'AI_PROMPT').map((s) => s.id), name: groupOf(route.goToGroupId).name };
    }
    return undefined;
  };

  const executions = new Map<string, number>(); // total executions per step (across loops)
  const loops = new Map<string, number>(); // loops per sender: step id, or `group:<id>`
  const feedbackFor = new Map<string, FailureFeedback>(); // pending feedback per target step
  const groupFindings = new Map<string, FeedbackSource[]>(); // findings collected during a pass through a group
  /** steps that are finished for dependency purposes (completed, or failed but collected by their group's send back) */
  const settled = new Set<string>();
  let completedOrder: string[] = [];
  let totalLoops = 0;

  /** One step incl. technical retries; reports through the hooks. Never throws. */
  const runStep = async (step: ResolvedStep): Promise<StepOutcome> => {
    const feedback = feedbackFor.get(step.id);
    feedbackFor.delete(step.id);
    const maxAttempts = 1 + (step.onError.mode === 'retry' ? Math.min(step.onError.maxRetries, cap) : 0);
    let outcome: StepOutcome = { status: 'FAILED', kind: 'INTERNAL', message: 'not executed', technical: false };
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const exec = (executions.get(step.id) ?? 0) + 1;
      executions.set(step.id, exec);
      await hooks.onStepStart?.(step, exec);
      try {
        outcome = await executor.execute(step, { attempt, feedback });
      } catch (e) {
        outcome = { status: 'FAILED', kind: 'INTERNAL', message: (e as Error).message, technical: true };
      }
      await hooks.onStepEnd?.(step, outcome, exec);
      if (outcome.status !== 'FAILED' || !outcome.technical) break;
      if (opts.isStopRequested?.()) break;
    }
    return outcome;
  };

  const markDone = (step: ResolvedStep) => { settled.add(step.id); completedOrder.push(step.id); };

  /** One pass through a group: start every step whose dependencies are settled (up to `limit` at once) until all are settled. */
  const runPhase = async (gid: string): Promise<PhaseResult> => {
    const gsteps = steps.filter((s) => s.groupId === gid);
    const deps = new Map(gsteps.map((s, k) => [s.id, stepDependencies(gsteps, k)]));
    const pending = gsteps.filter((s) => !settled.has(s.id));
    const running = new Map<string, Promise<{ step: ResolvedStep; outcome: StepOutcome }>>();
    const busy = () => [...running.keys()].filter((id) => steps[indexOf.get(id)!].type !== 'HUMAN_APPROVAL').length; // waiting for a human costs nothing
    let abort: PhaseResult | null = null;

    const handle = async (step: ResolvedStep, outcome: StepOutcome) => {
      if (abort) { if (outcome.status === 'COMPLETED') markDone(step); return; } // winding down: only keep what really finished
      if (outcome.status === 'STOPPED' || opts.isStopRequested?.() && outcome.status !== 'COMPLETED') { abort = { kind: 'stopped', stepId: step.id }; return; }

      // problems found: a failed step, or an AI step that succeeded but reports needs_rework (standard result field)
      const rework = outcome.status === 'COMPLETED' && step.type === 'AI_PROMPT' ? extractRework(outcome.output) : { requested: false, notes: null };
      const failure = outcome.status === 'FAILED' ? outcome : null;
      if (!failure && !rework.requested) {
        groupFindings.set(gid, (groupFindings.get(gid) ?? []).filter((f) => f.stepId !== step.id)); // fixed in this pass
        markDone(step);
        return;
      }
      const route = step.sendBack;
      const target = targetOf(route);
      const canRoute = !!route && !!target && target.index < indexOf.get(step.id)!;
      const used = loops.get(step.id) ?? 0;
      const source: FeedbackSource = {
        stepId: step.id, stepName: step.name, reason: failure ? 'failure' : 'rework',
        message: failure ? failure.message : rework.notes ?? 'The step reports that rework is needed',
        output: (failure ? failure.output : (outcome as { output?: Record<string, unknown> | null }).output) ?? null,
      };
      if (canRoute && used < route.maxLoops && totalLoops < loopCap) {
        loops.set(step.id, used + 1);
        totalLoops++;
        abort = { kind: 'jump', from: step, target, fb: { fromStepId: step.id, fromStepName: step.name, fromGroup: null, loop: used + 1, maxLoops: route.maxLoops, reason: source.reason, message: source.message, output: source.output, sources: [source] } };
        return;
      }
      if (canRoute) {
        const note = ` (gave up after ${plural(used)} back to "${target.name}")`;
        abort = failure
          ? { kind: 'fail', stepId: step.id, kind2: failure.kind, message: failure.message + note }
          : { kind: 'fail', stepId: step.id, kind2: 'REWORK_EXHAUSTED', message: `"${step.name}" still reports problems${note}: ${rework.notes ?? 'rework needed'}` };
        return;
      }
      // no route of its own: the group may collect it and send everything back at the end
      const groupRoute = groupOf(gid)?.sendBack;
      const groupTarget = targetOf(groupRoute);
      if (groupRoute && groupTarget && groupTarget.index < firstIdx.get(gid)!) {
        groupFindings.set(gid, [...(groupFindings.get(gid) ?? []).filter((f) => f.stepId !== step.id), source]);
        settled.add(step.id); // finished for its dependents; a hard failure is not "completed"
        if (!failure) completedOrder.push(step.id);
        return;
      }
      if (failure) { abort = { kind: 'fail', stepId: step.id, kind2: failure.kind, message: failure.message }; return; }
      markDone(step); // findings without any route: the step only reports and the workflow goes on
    };

    while (true) {
      if (!abort && opts.isStopRequested?.()) abort = { kind: 'stopped' };
      while (!abort) {
        const next = pending.find((s) => deps.get(s.id)!.every((d) => settled.has(d)) && (s.type === 'HUMAN_APPROVAL' || busy() < limit));
        if (!next) break;
        pending.splice(pending.indexOf(next), 1);
        running.set(next.id, runStep(next).then((outcome) => ({ step: next, outcome })));
      }
      if (!running.size) break;
      const r = await Promise.race(running.values());
      running.delete(r.step.id);
      await handle(r.step, r.outcome);
    }
    if (abort) return abort;
    if (pending.length) return { kind: 'fail', stepId: pending[0].id, kind2: 'INTERNAL', message: `Step "${pending[0].name}" can never start: its dependencies are not satisfiable` };
    return { kind: 'done' };
  };

  /** Continue at an earlier step/group: from there on everything has to be done again. */
  const jumpBack = async (from: ResolvedStep, target: { index: number; ids: string[] }, fb: FailureFeedback) => {
    for (const id of target.ids) feedbackFor.set(id, fb);
    const stale = (id: string) => (indexOf.get(id) ?? -1) >= target.index;
    for (const id of [...settled]) if (stale(id)) settled.delete(id);
    completedOrder = completedOrder.filter((id) => !stale(id));
    for (const [gid, list] of groupFindings) groupFindings.set(gid, list.filter((f) => !stale(f.stepId)));
    await hooks.onLoop?.(from, steps[target.index], fb);
  };

  let g = 0;
  while (g < groupOrder.length) {
    const gid = groupOrder[g];
    if (opts.isStopRequested?.()) return { status: 'STOPPED', completedSteps: completedOrder };
    if (currentGroup !== gid) {
      if (currentGroup) await hooks.onGroupEnd?.(groupOf(currentGroup));
      currentGroup = gid;
      await hooks.onGroupStart?.(groupOf(gid));
    }

    const res = await runPhase(gid);
    if (res.kind === 'stopped') return { status: 'STOPPED', failedStepId: res.stepId, completedSteps: completedOrder };
    if (res.kind === 'fail') return { status: 'FAILED', failedStepId: res.stepId, failure: { kind: res.kind2, message: res.message }, completedSteps: completedOrder };
    if (res.kind === 'jump') {
      await jumpBack(res.from, res.target, res.fb);
      g = groupOrder.indexOf(steps[res.target.index].groupId);
      continue;
    }

    // end of a group with a send back: ALL steps ran; now send the findings of all of them back together
    const group = groupOf(gid);
    const findings = [...(groupFindings.get(gid) ?? [])].sort((a, b) => indexOf.get(a.stepId)! - indexOf.get(b.stepId)!);
    const route = group.sendBack;
    const target = targetOf(route);
    if (route && target && target.index < firstIdx.get(gid)! && findings.length) {
      const key = `group:${gid}`;
      const used = loops.get(key) ?? 0;
      const summary = findings.map((f) => `"${f.stepName}": ${f.message}`).join('\n');
      if (used < route.maxLoops && totalLoops < loopCap) {
        loops.set(key, used + 1);
        totalLoops++;
        groupFindings.delete(gid);
        await jumpBack(steps[lastIdx.get(gid)!], target, {
          fromStepId: steps[lastIdx.get(gid)!].id, fromStepName: group.name, fromGroup: group.name, loop: used + 1, maxLoops: route.maxLoops,
          reason: findings.some((f) => f.reason === 'failure') ? 'failure' : 'rework', message: summary,
          output: { findings: findings.map((f) => ({ step: f.stepName, reason: f.reason, message: f.message, output: f.output })) }, sources: findings,
        });
        g = groupOrder.indexOf(steps[target.index].groupId);
        continue;
      }
      return { status: 'FAILED', failedStepId: findings[0].stepId, failure: { kind: 'REWORK_EXHAUSTED', message: `Group "${group.name}" still reports problems (gave up after ${plural(used)} back to "${target.name}"):\n${summary}` }, completedSteps: completedOrder };
    }
    g++;
  }
  if (currentGroup) await hooks.onGroupEnd?.(groupOf(currentGroup));
  return { status: 'COMPLETED', completedSteps: completedOrder };
}
