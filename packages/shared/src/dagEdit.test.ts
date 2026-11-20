import { describe, expect, it } from 'vitest';
import { appendStep, duplicateStep, insertStepAt, materializeDeps, moveStep, removeStepBridging, stepSinks } from './dagEdit.js';
import { StepDefSchema, stepDependencies, validateWorkflowDef, type WorkflowDef } from './workflow.js';

const st = (id: string, extra: Record<string, unknown> = {}) => StepDefSchema.parse({ id, name: id, type: 'AI_PROMPT', prompt: 'p', ...extra });
const def = (...steps: ReturnType<typeof st>[]): WorkflowDef => ({ groups: [{ id: 'g', name: 'G', steps }] });
const depsOf = (d: WorkflowDef) => Object.fromEntries(d.groups[0].steps.map((s, i) => [s.id, stepDependencies(d.groups[0].steps, i)]));

describe('editing workflows with dependencies', () => {
  it('materializing makes the implicit "after the previous step" explicit without changing the meaning', () => {
    const d = def(st('a'), st('b'), st('c', { dependsOn: [] }));
    const m = materializeDeps(d);
    expect(m.groups[0].steps.map((s) => s.dependsOn)).toEqual([[], ['a'], []]);
    expect(depsOf(m)).toEqual(depsOf(d));
  });

  it('finds the sinks of a group (what the next group waits for)', () => {
    expect(stepSinks(def(st('a'), st('b'), st('c')).groups[0].steps)).toEqual(['c']);
    expect(stepSinks(def(st('a', { dependsOn: [] }), st('b', { dependsOn: [] }), st('c', { dependsOn: ['a'] })).groups[0].steps)).toEqual(['b', 'c']);
  });

  it('inserting between two steps rewires the successor; the neighbours keep their meaning', () => {
    const d = def(st('a'), st('b'), st('c'));
    const r = insertStepAt(d, 'g', 1, st('x'), ['a'], { stepId: 'b', replace: 'a' });
    expect(depsOf(r.def)).toEqual({ a: [], x: ['a'], b: ['x'], c: ['b'] }); // a -> x -> b -> c
    expect(validateWorkflowDef(r.def)).toEqual([]);
  });

  it('inserting before a step that has no dependencies', () => {
    const d = def(st('a', { dependsOn: [] }), st('b', { dependsOn: [] }));
    const r = insertStepAt(d, 'g', 1, st('x'), [], { stepId: 'b', replace: null });
    expect(depsOf(r.def)).toEqual({ a: [], x: [], b: ['x'] }); // x -> b, a stays independent
  });

  it('appending depends on everything at the end of the group (a join)', () => {
    const d = def(st('a', { dependsOn: [] }), st('b', { dependsOn: [] }));
    expect(depsOf(appendStep(d, 'g', st('z')).def).z).toEqual(['a', 'b']);
    expect(depsOf(appendStep(def(st('a'), st('b')), 'g', st('z')).def).z).toEqual(['b']);
    expect(depsOf(appendStep({ groups: [{ id: 'g', name: 'G', steps: [] }] }, 'g', st('first')).def).first).toEqual([]);
  });

  it('removing a step bridges its dependents to what it waited for', () => {
    const d = def(st('a', { dependsOn: [] }), st('b', { dependsOn: ['a'] }), st('c', { dependsOn: ['b'] }), st('d', { dependsOn: ['b', 'a'] }));
    const r = removeStepBridging(d, 'b');
    expect(r.removed?.id).toBe('b');
    expect(depsOf(r.def)).toEqual({ a: [], c: ['a'], d: ['a'] });
    expect(validateWorkflowDef(r.def)).toEqual([]);
    expect(removeStepBridging(d, 'nope').removed).toBeNull();
  });

  it('moving a step re-attaches it after the step before the new position and keeps the rest connected', () => {
    const d = def(st('a'), st('b'), st('c'), st('d')); // a -> b -> c -> d
    const m = moveStep(d, 'b', 'g', 3); // after c (index 3 once b is out: a, c, d -> before the end?)
    expect(m.groups[0].steps.map((s) => s.id)).toEqual(['a', 'c', 'd', 'b']);
    expect(depsOf(m)).toEqual({ a: [], c: ['a'], d: ['c'], b: ['d'] });
    expect(validateWorkflowDef(m)).toEqual([]);
    expect(moveStep(d, 'nope', 'g', 0)).toBe(d);
  });

  it('moving a step across groups', () => {
    const d: WorkflowDef = { groups: [{ id: 'g1', name: 'G1', steps: [st('a'), st('b')] }, { id: 'g2', name: 'G2', steps: [st('c')] }] };
    const m = moveStep(d, 'b', 'g2', 0);
    expect(m.groups.map((g) => g.steps.map((s) => s.id))).toEqual([['a'], ['b', 'c']]);
    expect(m.groups[1].steps[0].dependsOn).toEqual([]); // starts its new group
  });

  it('duplicating puts the copy right after the original; dependents of the original wait for the copy', () => {
    const d = def(st('a'), st('b'), st('c'));
    const r = duplicateStep(d, 'b', st('b2'))!;
    expect(depsOf(r.def)).toEqual({ a: [], b: ['a'], b2: ['b'], c: ['b2'] });
    expect(duplicateStep(d, 'nope', st('x'))).toBeNull();
  });
});
