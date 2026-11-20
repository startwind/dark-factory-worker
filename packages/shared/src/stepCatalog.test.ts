import { describe, expect, it } from 'vitest';
import { STEP_CATALOG, STEP_CATEGORIES, findStepTemplate } from './stepCatalog.js';
import { buildJsonSchema, extractRework } from './output.js';
import { StepDefSchema, stepDependencies, stepLevels, validateWorkflowDef } from './workflow.js';

describe('step marketplace catalog', () => {
  it('ships 10 steps with unique ids and known categories', () => {
    expect(STEP_CATALOG).toHaveLength(10);
    expect(new Set(STEP_CATALOG.map((t) => t.id)).size).toBe(10);
    for (const t of STEP_CATALOG) {
      expect(t.id.startsWith('builtin/')).toBe(true);
      expect(STEP_CATEGORIES).toContain(t.category);
      expect(t.name && t.description).toBeTruthy();
      expect(t.step.type).toBe(t.type);
    }
  });

  it('every template is a valid step once inserted into a workflow', () => {
    for (const t of STEP_CATALOG) {
      const step = StepDefSchema.parse({ ...t.step, id: 'x1' });
      expect(validateWorkflowDef({ groups: [{ id: 'g', name: 'G', steps: [step] }] }), t.id).toEqual([]);
    }
  });

  it('AI steps have a prompt and output contract, shell steps a command', () => {
    for (const t of STEP_CATALOG) {
      if (t.type === 'AI_PROMPT') { expect(t.step.prompt.length).toBeGreaterThan(40); expect(t.step.expectedOutputs.length).toBeGreaterThan(0); }
      if (t.type === 'SHELL') expect(t.step.command).toBeTruthy();
    }
  });

  it('looks templates up by id', () => {
    expect(findStepTemplate('builtin/run-tests')?.step.command).toContain('npm test');
    expect(findStepTemplate('nope')).toBeUndefined();
  });
});

describe('send back', () => {
  const s = (id: string, extra: Record<string, unknown> = {}) => StepDefSchema.parse({ id, name: id, type: 'AI_PROMPT', prompt: 'p', ...extra });
  const wf = (...steps: ReturnType<typeof s>[]) => ({ groups: [{ id: 'g', name: 'G', steps }] });

  it('old steps without sendBack get the default (no routing), and a valid backward route passes validation', () => {
    expect(StepDefSchema.parse({ id: 'x', name: 'x', type: 'SHELL', command: 'ls' }).sendBack).toEqual({ goToStepId: null, goToGroupId: null, maxLoops: 3 });
    expect(validateWorkflowDef(wf(s('impl'), s('qa', { sendBack: { goToStepId: 'impl', maxLoops: 3 } })))).toEqual([]);
  });
  it('rejects forward / unknown / non-AI targets', () => {
    expect(validateWorkflowDef(wf(s('qa', { sendBack: { goToStepId: 'impl' } }), s('impl'))).join()).toContain('EARLIER');
    expect(validateWorkflowDef(wf(s('a'), s('qa', { sendBack: { goToStepId: 'nope' } }))).join()).toContain('does not exist');
    const shell = StepDefSchema.parse({ id: 'sh', name: 'sh', type: 'SHELL', command: 'ls' });
    expect(validateWorkflowDef({ groups: [{ id: 'g', name: 'G', steps: [shell, s('qa', { sendBack: { goToStepId: 'sh' } })] }] }).join()).toContain('not one');
  });
  it('standard result fields needs_rework/rework_notes/observations are reserved output keys', () => {
    const out = (key: string) => [{ key, type: 'string' as const, required: false, instruction: '' }];
    for (const k of ['needs_rework', 'rework_notes', 'observations']) expect(validateWorkflowDef(wf(s('a', { expectedOutputs: out(k) }))).join()).toContain('reserved');
    expect(validateWorkflowDef(wf(s('a', { expectedOutputs: out('status') })))).toEqual([]); // "status" is free to use
  });
  it('extractRework reads the standard fields', () => {
    expect(extractRework({ needs_rework: true, rework_notes: ' SQL injection in login ' })).toEqual({ requested: true, notes: 'SQL injection in login' });
    expect(extractRework({ needs_rework: 'true' }).requested).toBe(true);
    for (const v of [{ needs_rework: false }, { needs_rework: 'no' }, {}, null]) expect(extractRework(v as never).requested).toBe(false);
  });
  it('the JSON schema of every AI step documents the standard fields', () => {
    const p = (buildJsonSchema([]) as { properties: Record<string, { type?: string }> }).properties;
    expect(p.needs_rework.type).toBe('boolean');
    expect(Object.keys(p)).toEqual(expect.arrayContaining(['needs_rework', 'rework_notes', 'observations']));
  });
  it('review/scan steps of the catalog report findings instead of fixing them', () => {
    for (const id of ['builtin/security-review', 'builtin/code-review']) {
      const t = STEP_CATALOG.find((x) => x.id === id)!;
      expect(t.step.prompt).toContain('needs_rework');
      expect(t.step.prompt).toContain('rework_notes');
      expect(t.step.prompt).toMatch(/Do NOT/);
    }
  });
  it('group routes: only to earlier steps/groups, one target kind, group needs an AI step', () => {
    const g = (id: string, steps: ReturnType<typeof s>[], sendBack?: Record<string, unknown>) => ({ id, name: id.toUpperCase(), steps, ...(sendBack ? { sendBack } : {}) });
    const shell = StepDefSchema.parse({ id: 'sh', name: 'sh', type: 'SHELL', command: 'ls' });
    const ok = { groups: [g('impl', [s('a')]), g('qa', [s('b'), s('c')], { goToStepId: 'a', maxLoops: 2 })] };
    expect(validateWorkflowDef(ok as never)).toEqual([]);
    expect(validateWorkflowDef({ groups: [g('impl', [s('a')]), g('qa', [s('b')], { goToGroupId: 'impl', maxLoops: 2 })] } as never)).toEqual([]);
    const bad = (route: Record<string, unknown>, groups = [g('impl', [s('a')]), g('qa', [s('b')], route)]) => validateWorkflowDef({ groups } as never).join();
    expect(bad({ goToStepId: 'b' })).toContain('EARLIER'); // a step of the group itself is not earlier than the group
    expect(bad({ goToGroupId: 'qa' })).toContain('EARLIER');
    expect(bad({ goToGroupId: 'nope' })).toContain('does not exist');
    expect(bad({ goToStepId: 'a', goToGroupId: 'impl' })).toContain('not both');
    expect(bad({ goToGroupId: 'impl' }, [g('impl', [shell]), g('qa', [s('b')], { goToGroupId: 'impl' })])).toContain('no AI step');
    // a step may go back to a group too
    expect(validateWorkflowDef({ groups: [g('impl', [s('a')]), g('qa', [s('b', { sendBack: { goToGroupId: 'impl' } })])] } as never)).toEqual([]);
  });
});

describe('dependencies and parallel steps', () => {
  const st = (id: string, extra: Record<string, unknown> = {}) => StepDefSchema.parse({ id, name: id, type: 'AI_PROMPT', prompt: 'p', ...extra });
  const wf = (...steps: ReturnType<typeof st>[]) => ({ groups: [{ id: 'g', name: 'G', steps }] });

  it('unset dependsOn means "after the previous step"; [] means none; unknown ids are ignored', () => {
    const steps = [st('a'), st('b'), st('c', { dependsOn: [] }), st('d', { dependsOn: ['a', 'c', 'ghost', 'a'] })];
    expect(steps.map((_, i) => stepDependencies(steps, i))).toEqual([[], ['a'], [], ['a', 'c']]);
  });

  it('levels: steps without dependencies share row 0 and may run side by side', () => {
    const steps = [st('a', { dependsOn: [] }), st('b', { dependsOn: [] }), st('c', { dependsOn: ['a', 'b'] }), st('d'), st('e', { dependsOn: ['b'] })];
    expect(stepLevels(steps)).toEqual([0, 0, 1, 2, 1]);
    expect(stepLevels([st('x'), st('y'), st('z')])).toEqual([0, 1, 2]); // classic sequential flow
  });

  it('validates dependencies: only earlier steps of the same group, no self, no duplicates', () => {
    expect(validateWorkflowDef(wf(st('a', { dependsOn: [] }), st('b', { dependsOn: ['a'] })))).toEqual([]);
    expect(validateWorkflowDef(wf(st('a', { dependsOn: ['b'] }), st('b'))).join()).toContain('EARLIER steps of its own group');
    expect(validateWorkflowDef(wf(st('a'), st('b', { dependsOn: ['b'] }))).join()).toContain('depend on itself');
    expect(validateWorkflowDef(wf(st('a'), st('b', { dependsOn: ['a', 'a'] }))).join()).toContain('duplicate dependency');
    const other = { groups: [{ id: 'g1', name: 'G1', steps: [st('a')] }, { id: 'g2', name: 'G2', steps: [st('b', { dependsOn: ['a'] })] }] };
    expect(validateWorkflowDef(other).join()).toContain('own group'); // dependencies never cross groups
  });

  it('the Pull Request step has to wait for every other step of its group', () => {
    const pr = (extra: Record<string, unknown> = {}) => StepDefSchema.parse({ id: 'pr', name: 'PR', type: 'PULL_REQUEST', ...extra });
    expect(validateWorkflowDef(wf(st('a', { dependsOn: [] }), st('b', { dependsOn: [] }), pr({ dependsOn: ['a', 'b'] })))).toEqual([]);
    expect(validateWorkflowDef(wf(st('a'), st('b'), pr())).join()).toBe(''); // sequential: all are ancestors
    const bad = validateWorkflowDef(wf(st('a', { dependsOn: [] }), st('b', { dependsOn: [] }), pr({ dependsOn: ['a'] }))).join();
    expect(bad).toContain('has to wait for all other steps');
    expect(bad).toContain('"b"');
  });
});
