import { describe, expect, it } from 'vitest';
import { StepDefSchema, type WorkflowDef } from '@nova/shared';
import { resolveWorkflow, requiredAgentKeys } from './resolve.js';
import { runWorkflow, type StepExecutor, type StepOutcome } from './engine.js';

const step = (id: string, extra: Record<string, unknown> = {}) =>
  StepDefSchema.parse({ id, name: id, type: 'AI_PROMPT', prompt: 'do it', ...extra });

const def: WorkflowDef = {
  groups: [
    { id: 'g1', name: 'Implementation', steps: [step('a'), step('b', { agentKey: 'claude' })] },
    { id: 'g2', name: 'Quality Assurance', steps: [StepDefSchema.parse({ id: 'c', name: 'tests', type: 'SHELL', command: 'npm test' })] },
  ],
};
const ctx = { workflowId: 'w', workflowName: 'W', versionId: 'v', version: 1, projectDefaultAgentKey: 'codex', jiraStatusMap: { Implementation: 'In Progress' } };

describe('resolveWorkflow', () => {
  it('applies project default and per-step override', () => {
    const wf = resolveWorkflow(def, ctx);
    expect(wf.steps.map((s) => [s.id, s.resolvedAgentKey, s.agentSource])).toEqual([
      ['a', 'codex', 'project-default'],
      ['b', 'claude', 'override'],
      ['c', null, null],
    ]);
    expect(requiredAgentKeys(wf).sort()).toEqual(['claude', 'codex']);
  });
  it('a changed project default only affects steps without override, and the frozen run is unaffected', () => {
    const frozen = resolveWorkflow(def, ctx);
    const later = resolveWorkflow(def, { ...ctx, projectDefaultAgentKey: 'claude' });
    expect(later.steps[0].resolvedAgentKey).toBe('claude');
    expect(frozen.steps[0].resolvedAgentKey).toBe('codex');
  });
  it('status mapping targets (stable ids) win over the legacy name map and are frozen with the run', () => {
    const targets = { field: 'labels', level: 'group' as const, groups: { g1: 'Factory: Implementation' }, steps: {}, managed: ['Factory: Implementation'] };
    const wf = resolveWorkflow(def, { ...ctx, statusTargets: targets });
    expect(wf.groups.map((g) => g.jiraStatus)).toEqual(['Factory: Implementation', null]);
    expect(wf.statusTargets).toEqual(targets);
    expect(resolveWorkflow(def, ctx).statusTargets).toBeUndefined();
  });
  it('maps group names to Jira statuses', () => {
    const wf = resolveWorkflow(def, ctx);
    expect(wf.groups.map((g) => g.jiraStatus)).toEqual(['In Progress', null]);
  });
});

function exec(outcomes: Record<string, StepOutcome[]>, log: string[] = []): StepExecutor {
  const counters: Record<string, number> = {};
  return {
    async execute(s, { attempt }) {
      log.push(`${s.id}#${attempt}`);
      const n = (counters[s.id] = (counters[s.id] ?? 0) + 1);
      const list = outcomes[s.id] ?? [{ status: 'COMPLETED' }];
      return list[Math.min(n, list.length) - 1];
    },
  };
}

describe('runWorkflow', () => {
  it('runs steps strictly sequentially and fires group hooks', async () => {
    const events: string[] = [];
    const res = await runWorkflow(resolveWorkflow(def, ctx), exec({}), {
      onGroupStart: (g) => void events.push(`+${g.name}`),
      onGroupEnd: (g) => void events.push(`-${g.name}`),
      onStepStart: (s) => void events.push(`s:${s.id}`),
    });
    expect(res.status).toBe('COMPLETED');
    expect(events).toEqual(['+Implementation', 's:a', 's:b', '-Implementation', '+Quality Assurance', 's:c', '-Quality Assurance']);
  });

  it('halts on functional failures without retry', async () => {
    const log: string[] = [];
    const res = await runWorkflow(resolveWorkflow(def, ctx), exec({ a: [{ status: 'FAILED', kind: 'INVALID_JSON', message: 'bad', technical: false }] }, log));
    expect(res.status).toBe('FAILED');
    expect(res.failedStepId).toBe('a');
    expect(log).toEqual(['a#1']);
  });

  it('retries technical failures a bounded number of times', async () => {
    const d: WorkflowDef = { groups: [{ id: 'g', name: 'G', steps: [step('x', { onError: { mode: 'retry', maxRetries: 2 } })] }] };
    const log: string[] = [];
    const fail: StepOutcome = { status: 'FAILED', kind: 'AGENT_TIMEOUT', message: 't', technical: true };
    const res = await runWorkflow(resolveWorkflow(d, ctx), exec({ x: [fail, fail, fail, fail] }, log));
    expect(res.status).toBe('FAILED');
    expect(log).toEqual(['x#1', 'x#2', 'x#3']); // 1 + 2 retries, never unbounded
  });

  it('does not retry when mode=stop even for technical errors', async () => {
    const log: string[] = [];
    const fail: StepOutcome = { status: 'FAILED', kind: 'AGENT_TIMEOUT', message: 't', technical: true };
    await runWorkflow(resolveWorkflow(def, ctx), exec({ a: [fail] }, log));
    expect(log).toEqual(['a#1']);
  });

  it('succeeds after a transient failure', async () => {
    const d: WorkflowDef = { groups: [{ id: 'g', name: 'G', steps: [step('x', { onError: { mode: 'retry', maxRetries: 2 } })] }] };
    const fail: StepOutcome = { status: 'FAILED', kind: 'AGENT_TIMEOUT', message: 't', technical: true };
    const res = await runWorkflow(resolveWorkflow(d, ctx), exec({ x: [fail, { status: 'COMPLETED' }] }));
    expect(res.status).toBe('COMPLETED');
  });

  it('stops before the next step when stop is requested', async () => {
    let stop = false;
    const log: string[] = [];
    const executor: StepExecutor = { execute: async (s) => ((log.push(s.id), (stop = true)), { status: 'COMPLETED' as const }) };
    const res = await runWorkflow(resolveWorkflow(def, ctx), executor, {}, { isStopRequested: () => stop });
    expect(res.status).toBe('STOPPED');
    expect(log).toEqual(['a']);
  });
});

describe('runWorkflow: send back (findings are fixed by an earlier step)', () => {
  const impl = step('impl');
  const qa = (extra: Record<string, unknown> = {}) => step('qa', { sendBack: { goToStepId: 'impl', maxLoops: 2 }, ...extra });
  const loopDef = (q = qa()): WorkflowDef => ({ groups: [{ id: 'gi', name: 'Implementation', steps: [impl] }, { id: 'gq', name: 'QA', steps: [q] }, { id: 'gd', name: 'Delivery', steps: [step('docs')] }] });
  const findings = (notes = 'login crashes', extra: Record<string, unknown> = {}): StepOutcome => ({ status: 'COMPLETED', output: { needs_rework: true, rework_notes: notes, ...extra }, metrics: { findings: 7 } });

  it('a step reporting needs_rework SUCCEEDS, sends the workflow back and hands its findings over as feedback', async () => {
    const log: string[] = [];
    const ends: string[] = [];
    const feedback: Record<string, unknown>[] = [];
    const ex: StepExecutor = {
      async execute(s, c) {
        log.push(s.id);
        if (c.feedback) feedback.push({ to: s.id, ...c.feedback });
        if (s.id === 'qa') return log.filter((x) => x === 'qa').length === 1 ? findings('login crashes', { findings: 7 }) : { status: 'COMPLETED', output: { findings: 0 } };
        return { status: 'COMPLETED' };
      },
    };
    const loops: string[] = [];
    const res = await runWorkflow(resolveWorkflow(loopDef(), ctx), ex, {
      onStepEnd: (s, o) => void ends.push(`${s.id}:${o.status}`),
      onLoop: (from, to, fb) => void loops.push(`${from.id}->${to.id}#${fb.loop}/${fb.maxLoops}`),
    });
    expect(res.status).toBe('COMPLETED');
    expect(log).toEqual(['impl', 'qa', 'impl', 'qa', 'docs']);
    expect(ends).toEqual(['impl:COMPLETED', 'qa:COMPLETED', 'impl:COMPLETED', 'qa:COMPLETED', 'docs:COMPLETED']); // the scan never "failed"
    expect(loops).toEqual(['qa->impl#1/2']);
    expect(feedback).toHaveLength(1);
    expect(feedback[0]).toMatchObject({ to: 'impl', fromStepId: 'qa', reason: 'rework', message: 'login crashes', output: { needs_rework: true, rework_notes: 'login crashes', findings: 7 } });
    expect(res.completedSteps).toEqual(['impl', 'qa', 'docs']);
  });

  it('without "send back to" a reporting step only reports: the workflow just continues', async () => {
    const res = await runWorkflow(resolveWorkflow({ groups: [{ id: 'g', name: 'G', steps: [impl, step('qa'), step('docs')] }] }, ctx), exec({ qa: [findings()] }));
    expect(res.status).toBe('COMPLETED');
    expect(res.completedSteps).toEqual(['impl', 'qa', 'docs']);
  });

  it('needs_rework false / missing / non-boolean does not send anything back', async () => {
    for (const out of [{ needs_rework: false }, {}, { needs_rework: 'no' }]) {
      const log: string[] = [];
      const res = await runWorkflow(resolveWorkflow(loopDef(), ctx), exec({ qa: [{ status: 'COMPLETED', output: out }] }, log));
      expect(res.status).toBe('COMPLETED');
      expect(log).toEqual(['impl#1', 'qa#1', 'docs#1']);
    }
  });

  it('when the loops are used up the WORKFLOW stops (not the step) with the open findings', async () => {
    const res = await runWorkflow(resolveWorkflow(loopDef(), ctx), exec({ qa: [findings('2 criticals')] }));
    expect(res).toMatchObject({ status: 'FAILED', failedStepId: 'qa', failure: { kind: 'REWORK_EXHAUSTED' } });
    expect(res.failure!.message).toContain('gave up after 2 loops back to "impl"');
    expect(res.failure!.message).toContain('2 criticals');
  });

  it('attempt numbers keep counting across loops (never repeat) and group hooks follow the jump', async () => {
    const events: string[] = [];
    await runWorkflow(resolveWorkflow(loopDef(), ctx), exec({ qa: [findings(), { status: 'COMPLETED', output: {} }] }), {
      onStepStart: (s, a) => void events.push(`${s.id}#${a}`),
      onGroupStart: (g) => void events.push(`+${g.name}`),
    });
    expect(events).toEqual(['+Implementation', 'impl#1', '+QA', 'qa#1', '+Implementation', 'impl#2', '+QA', 'qa#2', '+Delivery', 'docs#1']);
  });

  it('a hard failure (e.g. failing tests) is sent back too and passes the shell tail along', async () => {
    const shell = StepDefSchema.parse({ id: 'qa', name: 'tests', type: 'SHELL', command: 'npm test', sendBack: { goToStepId: 'impl', maxLoops: 1 } });
    let n = 0;
    const ex: StepExecutor = { async execute(s) { if (s.id === 'qa' && ++n === 1) return { status: 'FAILED', kind: 'COMMAND_FAILED', message: 'exit 1', technical: false, output: { exit_code: 1, output_tail: '2 tests failed' } }; return { status: 'COMPLETED' }; } };
    const fbs: unknown[] = [];
    const res = await runWorkflow(resolveWorkflow(loopDef(shell), ctx), ex, { onLoop: (_f, _t, fb) => void fbs.push([fb.reason, fb.output]) });
    expect(res.status).toBe('COMPLETED');
    expect(fbs).toEqual([['failure', { exit_code: 1, output_tail: '2 tests failed' }]]);
  });

  it('a hard failure without a target stops the workflow; a stop request wins over looping back', async () => {
    const fail = resolveWorkflow({ groups: [{ id: 'g', name: 'G', steps: [impl, step('qa')] }] }, ctx);
    expect((await runWorkflow(fail, exec({ qa: [{ status: 'FAILED', kind: 'COMMAND_FAILED', message: 'x', technical: false }] }))).status).toBe('FAILED');
    let stop = false;
    const ex: StepExecutor = { async execute(s) { if (s.id === 'qa') { stop = true; return findings(); } return { status: 'COMPLETED' }; } };
    expect((await runWorkflow(resolveWorkflow(loopDef(), ctx), ex, {}, { isStopRequested: () => stop })).status).toBe('STOPPED');
  });
});

describe('runWorkflow: send back for a whole group, and back to a group', () => {
  const ai = (id: string, extra: Record<string, unknown> = {}) => step(id, extra);
  const sh = (id: string, extra: Record<string, unknown> = {}) => StepDefSchema.parse({ id, name: id, type: 'SHELL', command: 'npm test', ...extra });
  const findings = (notes: string, extra: Record<string, unknown> = {}): StepOutcome => ({ status: 'COMPLETED', output: { needs_rework: true, rework_notes: notes, ...extra } });
  // Implementation -> QA group (security, review, tests) which sends back to Implementation after ALL its steps ran
  const qaDef = (route: Record<string, unknown> = { goToStepId: 'impl', maxLoops: 2 }): WorkflowDef => ({
    groups: [
      { id: 'gi', name: 'Implementation', steps: [ai('impl')] },
      { id: 'gq', name: 'Quality Assurance', steps: [ai('sec'), ai('review'), sh('tests')], sendBack: { goToStepId: null, goToGroupId: null, maxLoops: 3, ...route } },
      { id: 'gd', name: 'Delivery', steps: [ai('docs')] },
    ],
  });

  it('runs ALL steps of the group first, then sends the findings of all of them back together', async () => {
    const log: string[] = [];
    const seen: Record<string, unknown>[] = [];
    let pass = 0;
    const ex: StepExecutor = {
      async execute(s, c) {
        log.push(s.id);
        if (c.feedback) seen.push({ to: s.id, ...c.feedback });
        if (s.id === 'impl') pass++;
        if (pass === 1 && s.id === 'sec') return findings('SQL injection in login');
        if (pass === 1 && s.id === 'review') return findings('dead code in auth.ts');
        if (pass === 1 && s.id === 'tests') return { status: 'FAILED', kind: 'COMMAND_FAILED', message: 'exit 1', technical: false, output: { exit_code: 1, output_tail: '2 tests failed' } };
        return { status: 'COMPLETED', output: {} };
      },
    };
    const loops: string[] = [];
    const res = await runWorkflow(resolveWorkflow(qaDef(), ctx), ex, { onLoop: (from, to, fb) => void loops.push(`${from.id}->${to.id} group=${fb.fromGroup} #${fb.loop}/${fb.maxLoops}`) });
    expect(res.status).toBe('COMPLETED');
    expect(log).toEqual(['impl', 'sec', 'review', 'tests', 'impl', 'sec', 'review', 'tests', 'docs']); // the failing tests did not interrupt the group
    expect(loops).toEqual(['tests->impl group=Quality Assurance #1/2']);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ to: 'impl', fromGroup: 'Quality Assurance', reason: 'failure' });
    expect((seen[0].sources as { stepName: string; reason: string; message: string }[]).map((x) => [x.stepName, x.reason])).toEqual([['sec', 'rework'], ['review', 'rework'], ['tests', 'failure']]);
    expect(String(seen[0].message)).toContain('SQL injection in login');
    expect(String(seen[0].message)).toContain('dead code in auth.ts');
    expect(res.completedSteps).toEqual(['impl', 'sec', 'review', 'tests', 'docs']);
  });

  it('with no findings the group just passes; a group without route behaves as before (hard failure stops)', async () => {
    const log: string[] = [];
    expect((await runWorkflow(resolveWorkflow(qaDef(), ctx), exec({}, log))).status).toBe('COMPLETED');
    expect(log).toEqual(['impl#1', 'sec#1', 'review#1', 'tests#1', 'docs#1']);
    const noRoute = qaDef({});
    const res = await runWorkflow(resolveWorkflow(noRoute, ctx), exec({ tests: [{ status: 'FAILED', kind: 'COMMAND_FAILED', message: 'x', technical: false }] }));
    expect(res).toMatchObject({ status: 'FAILED', failedStepId: 'tests' });
  });

  it('when the group loops are used up the workflow stops and lists the open findings of all steps', async () => {
    const res = await runWorkflow(resolveWorkflow(qaDef(), ctx), exec({ sec: [findings('SQLi')], review: [findings('dead code')] }));
    expect(res).toMatchObject({ status: 'FAILED', failure: { kind: 'REWORK_EXHAUSTED' } });
    expect(res.failure!.message).toContain('Group "Quality Assurance"');
    expect(res.failure!.message).toContain('gave up after 2 loops back to "impl"');
    expect(res.failure!.message).toContain('"sec": SQLi');
    expect(res.failure!.message).toContain('"review": dead code');
  });

  it('a step-level route inside the group still acts immediately and takes precedence', async () => {
    const def = qaDef();
    def.groups[1].steps[0] = ai('sec', { sendBack: { goToStepId: 'impl', maxLoops: 1 } });
    const log: string[] = [];
    let n = 0;
    const ex: StepExecutor = { async execute(s) { log.push(s.id); if (s.id === 'sec' && ++n === 1) return findings('SQLi'); return { status: 'COMPLETED', output: {} }; } };
    const res = await runWorkflow(resolveWorkflow(def, ctx), ex);
    expect(res.status).toBe('COMPLETED');
    expect(log.slice(0, 4)).toEqual(['impl', 'sec', 'impl', 'sec']); // sec sent back at once, review/tests did not run in between
  });

  it('a route can point to a GROUP: it continues at its first step and every AI step of that group gets the feedback', async () => {
    const def: WorkflowDef = {
      groups: [
        { id: 'gs', name: 'Specification', steps: [ai('spec')] },
        { id: 'gi', name: 'Implementation', steps: [ai('impl'), sh('build'), ai('impl2')] },
        { id: 'gq', name: 'QA', steps: [ai('qa', { sendBack: { goToStepId: null, goToGroupId: 'gi', maxLoops: 2 } })] },
      ],
    };
    const log: string[] = [];
    const got: string[] = [];
    let n = 0;
    const ex: StepExecutor = { async execute(s, c) { log.push(s.id); if (c.feedback) got.push(s.id); if (s.id === 'qa' && ++n === 1) return findings('crash'); return { status: 'COMPLETED', output: {} }; } };
    const res = await runWorkflow(resolveWorkflow(def, ctx), ex);
    expect(res.status).toBe('COMPLETED');
    expect(log).toEqual(['spec', 'impl', 'build', 'impl2', 'qa', 'impl', 'build', 'impl2', 'qa']); // back to the group START, spec is not repeated
    expect(got).toEqual(['impl', 'impl2']); // both AI steps of the group, not the shell step
  });

  it('a group can send back to a whole earlier group', async () => {
    const def: WorkflowDef = {
      groups: [
        { id: 'gi', name: 'Implementation', steps: [ai('impl'), ai('impl2')] },
        { id: 'gq', name: 'QA', steps: [ai('sec'), ai('review')], sendBack: { goToStepId: null, goToGroupId: 'gi', maxLoops: 1 } },
      ],
    };
    const log: string[] = [];
    let n = 0;
    const ex: StepExecutor = { async execute(s) { log.push(s.id); if (s.id === 'review' && ++n === 1) return findings('x'); return { status: 'COMPLETED', output: {} }; } };
    const res = await runWorkflow(resolveWorkflow(def, ctx), ex);
    expect(res.status).toBe('COMPLETED');
    expect(log).toEqual(['impl', 'impl2', 'sec', 'review', 'impl', 'impl2', 'sec', 'review']);
  });
});

describe('runWorkflow: dependencies and parallel steps', () => {
  const ai = (id: string, extra: Record<string, unknown> = {}) => step(id, extra);
  const group = (steps: ReturnType<typeof step>[], extra: Record<string, unknown> = {}) => ({ id: 'g', name: 'G', steps, ...extra });
  /** executor that takes `ms` per step and records how many steps ran at the same time */
  function timed(ms = 15, results: Record<string, StepOutcome> = {}) {
    const state = { running: 0, max: 0, log: [] as string[], ended: [] as string[] };
    const ex: StepExecutor = {
      async execute(s) {
        state.running++; state.max = Math.max(state.max, state.running); state.log.push(`+${s.id}`);
        await new Promise((r) => setTimeout(r, ms));
        state.running--; state.ended.push(s.id); state.log.push(`-${s.id}`);
        return results[s.id] ?? { status: 'COMPLETED', output: {} };
      },
    };
    return { ex, state };
  }
  const run = (def: WorkflowDef, ex: StepExecutor, opts = {}) => runWorkflow(resolveWorkflow(def, ctx), ex, {}, opts);

  it('steps without dependencies run at the same time when the worker allows it', async () => {
    const def: WorkflowDef = { groups: [group([ai('a', { dependsOn: [] }), ai('b', { dependsOn: [] }), ai('c', { dependsOn: [] })])] };
    const par = timed();
    expect((await run(def, par.ex, { maxParallel: 3 })).status).toBe('COMPLETED');
    expect(par.state.max).toBe(3);
    const seq = timed();
    expect((await run(def, seq.ex, { maxParallel: 1 })).status).toBe('COMPLETED');
    expect(seq.state.max).toBe(1); // the WORKER decides: one at a time
    expect(seq.state.log).toEqual(['+a', '-a', '+b', '-b', '+c', '-c']); // deterministic order
  });

  it('the worker limit caps parallelism', async () => {
    const def: WorkflowDef = { groups: [group(['a', 'b', 'c', 'd'].map((id) => ai(id, { dependsOn: [] })))] };
    const t = timed();
    await run(def, t.ex, { maxParallel: 2 });
    expect(t.state.max).toBe(2);
  });

  it('a step waits for ALL its dependencies; unset dependencies mean "after the previous step"', async () => {
    const def: WorkflowDef = { groups: [group([ai('a', { dependsOn: [] }), ai('b', { dependsOn: [] }), ai('c', { dependsOn: ['a', 'b'] }), ai('d')])] }; // d: after c
    const t = timed(10);
    await run(def, t.ex, { maxParallel: 4 });
    expect(t.state.log.indexOf('+c')).toBeGreaterThan(t.state.log.indexOf('-a'));
    expect(t.state.log.indexOf('+c')).toBeGreaterThan(t.state.log.indexOf('-b'));
    expect(t.state.log.indexOf('+d')).toBeGreaterThan(t.state.log.indexOf('-c'));
    expect(t.state.max).toBe(2); // only a and b overlapped
  });

  it('a workflow without any dependsOn stays strictly sequential, even with a high limit', async () => {
    const t = timed(5);
    await run({ groups: [group([ai('a'), ai('b'), ai('c')])] }, t.ex, { maxParallel: 8 });
    expect(t.state.max).toBe(1);
    expect(t.state.ended).toEqual(['a', 'b', 'c']);
  });

  it('groups stay sequential phases: the next group starts only when all parallel steps of the group are done', async () => {
    const def: WorkflowDef = { groups: [group([ai('a', { dependsOn: [] }), ai('b', { dependsOn: [] })]), { id: 'g2', name: 'G2', steps: [ai('c', { dependsOn: [] })] }] };
    const t = timed(10);
    await run(def, t.ex, { maxParallel: 4 });
    expect(t.state.log.indexOf('+c')).toBeGreaterThan(Math.max(t.state.log.indexOf('-a'), t.state.log.indexOf('-b')));
  });

  it('a group send back collects the findings of all parallel steps (in step order) and goes back once', async () => {
    const f = (n: string): StepOutcome => ({ status: 'COMPLETED', output: { needs_rework: true, rework_notes: n } });
    const def: WorkflowDef = {
      groups: [
        { id: 'gi', name: 'Impl', steps: [ai('impl')] },
        { id: 'gq', name: 'QA', steps: [ai('sec', { dependsOn: [] }), ai('review', { dependsOn: [] }), ai('docs', { dependsOn: [] })], sendBack: { goToStepId: 'impl', goToGroupId: null, maxLoops: 2 } },
      ],
    };
    let pass = 0;
    const seen: unknown[] = [];
    const ex: StepExecutor = {
      async execute(s, c) {
        if (s.id === 'impl') { pass++; if (c.feedback) seen.push(c.feedback.sources.map((x) => x.stepId)); }
        await new Promise((r) => setTimeout(r, s.id === 'sec' ? 20 : 5)); // sec finishes LAST
        if (pass === 1 && s.id === 'sec') return f('SQLi');
        if (pass === 1 && s.id === 'review') return f('dead code');
        return { status: 'COMPLETED', output: {} };
      },
    };
    const loops: string[] = [];
    const res = await runWorkflow(resolveWorkflow(def, ctx), ex, { onLoop: (from, to) => void loops.push(`${from.id}->${to.id}`) }, { maxParallel: 3 });
    expect(res.status).toBe('COMPLETED');
    expect(loops).toEqual(['docs->impl']); // group send back, "from" = the group's last step
    expect(seen).toEqual([['sec', 'review']]); // sorted by step order, not by finishing time
  });

  it('a step that sends the workflow back lets running siblings finish first and starts nothing new', async () => {
    const def: WorkflowDef = {
      groups: [
        { id: 'gi', name: 'Impl', steps: [ai('impl')] },
        { id: 'gq', name: 'QA', steps: [ai('a', { dependsOn: [], sendBack: { goToStepId: 'impl', goToGroupId: null, maxLoops: 1 } }), ai('slow', { dependsOn: [] }), ai('late', { dependsOn: ['a'] })] },
      ],
    };
    let pass = 0;
    const log: string[] = [];
    const ex: StepExecutor = {
      async execute(s) {
        if (s.id === 'impl') pass++;
        log.push(`+${s.id}`);
        await new Promise((r) => setTimeout(r, s.id === 'slow' ? 30 : 5));
        log.push(`-${s.id}`);
        if (pass === 1 && s.id === 'a') return { status: 'COMPLETED', output: { needs_rework: true, rework_notes: 'x' } };
        return { status: 'COMPLETED', output: {} };
      },
    };
    const res = await runWorkflow(resolveWorkflow(def, ctx), ex, {}, { maxParallel: 2 });
    expect(res.status).toBe('COMPLETED');
    // first pass: a and slow ran together; "late" (depends on a) never started before the jump; slow was awaited
    expect(log.slice(0, 7)).toEqual(['+impl', '-impl', '+a', '+slow', '-a', '-slow', '+impl']);
    expect(log.indexOf('+late')).toBeGreaterThan(log.lastIndexOf('+impl'));
  });

  it('a hard failure stops the workflow after the running siblings finished', async () => {
    const def: WorkflowDef = { groups: [group([ai('a', { dependsOn: [] }), ai('b', { dependsOn: [] }), ai('c', { dependsOn: ['a'] })])] };
    const t = timed(10, { a: { status: 'FAILED', kind: 'COMMAND_FAILED', message: 'boom', technical: false } });
    const res = await run(def, t.ex, { maxParallel: 2 });
    expect(res).toMatchObject({ status: 'FAILED', failedStepId: 'a', failure: { kind: 'COMMAND_FAILED' } });
    expect(t.state.ended).toContain('b'); // b was running and was awaited
    expect(t.state.log).not.toContain('+c');
  });

  it('a step waiting for a human approval does not use up the worker limit', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const approval = StepDefSchema.parse({ id: 'ok', name: 'ok', type: 'HUMAN_APPROVAL', dependsOn: [] });
    const def: WorkflowDef = { groups: [group([approval, ai('work', { dependsOn: [] })])] };
    const log: string[] = [];
    const ex: StepExecutor = {
      async execute(s) {
        log.push(`+${s.id}`);
        if (s.id === 'ok') await gate; else { await new Promise((r) => setTimeout(r, 10)); log.push('work done'); release(); }
        return { status: 'COMPLETED', output: {} };
      },
    };
    const res = await run(def, ex, { maxParallel: 1 });
    expect(res.status).toBe('COMPLETED'); // with limit 1 it would deadlock if the approval counted
    expect(log.slice(0, 2)).toEqual(['+ok', '+work']);
  });

  it('a stop request starts no further steps; unsatisfiable dependencies fail cleanly', async () => {
    let stop = false;
    const log: string[] = [];
    const ex: StepExecutor = { async execute(s) { log.push(s.id); stop = true; return { status: 'COMPLETED', output: {} }; } };
    const def: WorkflowDef = { groups: [group([ai('a', { dependsOn: [] }), ai('b', { dependsOn: [] })])] };
    expect((await run(def, ex, { maxParallel: 1, isStopRequested: () => stop })).status).toBe('STOPPED');
    expect(log).toEqual(['a']);
    const broken = resolveWorkflow({ groups: [group([ai('a', { dependsOn: ['ghost'] }), ai('b')])] }, ctx); // 'ghost' is ignored -> a has no deps
    expect((await runWorkflow(broken, timed().ex)).status).toBe('COMPLETED');
  });
});
