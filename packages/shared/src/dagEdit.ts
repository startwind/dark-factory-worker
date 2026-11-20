import { stepDependencies, type StepDef, type WorkflowDef } from './workflow.js';

/**
 * Editing a workflow whose steps have dependencies. Structural edits first make every dependency EXPLICIT: with the classic
 * implicit "after the previous step" rule, inserting or moving a step would silently change what its neighbours wait for.
 * After the first edit, array order no longer matters for the meaning - only `dependsOn` does.
 */

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

/** Every step gets an explicit `dependsOn` (its effective dependencies). */
export function materializeDeps(def: WorkflowDef): WorkflowDef {
  return { groups: def.groups.map((g) => ({ ...g, steps: g.steps.map((s, i) => ({ ...s, dependsOn: stepDependencies(g.steps, i) })) })) };
}

/** Steps nobody in the group depends on: the "end" of the group (what the next group waits for). */
export function stepSinks(steps: { id: string; dependsOn?: string[] }[]): string[] {
  const needed = new Set(steps.flatMap((_, i) => stepDependencies(steps, i)));
  return steps.filter((s) => !needed.has(s.id)).map((s) => s.id);
}

/** After inserting a step: this step used to wait for `replace` (or for nothing, if null) and now waits for the new step instead. */
export interface Relink { stepId: string; replace: string | null }

/** Insert `step` at `index` of the group with the given dependencies; optionally put it between two steps. */
export function insertStepAt(def: WorkflowDef, groupId: string, index: number, step: StepDef, deps: string[], relink?: Relink): { def: WorkflowDef; step: StepDef } {
  const n = materializeDeps(clone(def));
  const g = n.groups.find((x) => x.id === groupId);
  const added: StepDef = { ...step, dependsOn: [...deps] };
  if (g) {
    g.steps.splice(Math.max(0, Math.min(index, g.steps.length)), 0, added);
    const target = relink && g.steps.find((s) => s.id === relink.stepId);
    if (target) target.dependsOn = relink!.replace ? (target.dependsOn ?? []).map((d) => (d === relink!.replace ? added.id : d)) : [...(target.dependsOn ?? []), added.id];
  }
  return { def: n, step: added };
}

/** Append a step at the end of a group: it waits for everything that is currently at the end. */
export function appendStep(def: WorkflowDef, groupId: string, step: StepDef) {
  const g = def.groups.find((x) => x.id === groupId);
  return insertStepAt(def, groupId, g?.steps.length ?? 0, step, g ? stepSinks(materializeDeps(def).groups.find((x) => x.id === groupId)!.steps) : []);
}

/** Remove a step; the steps that waited for it now wait for what IT waited for (the flow stays connected). */
export function removeStepBridging(def: WorkflowDef, stepId: string): { def: WorkflowDef; removed: StepDef | null } {
  const n = materializeDeps(clone(def));
  let removed: StepDef | null = null;
  for (const g of n.groups) {
    const i = g.steps.findIndex((s) => s.id === stepId);
    if (i < 0) continue;
    removed = g.steps.splice(i, 1)[0];
    const via = removed.dependsOn ?? [];
    for (const s of g.steps) {
      if (!s.dependsOn?.includes(stepId)) continue;
      s.dependsOn = [...new Set(s.dependsOn.flatMap((d) => (d === stepId ? via : [d])))];
    }
  }
  return { def: n, removed };
}

/** Move a step to `index` of a group (also another one): it follows the step before that position, or starts the group. */
export function moveStep(def: WorkflowDef, stepId: string, groupId: string, index: number): WorkflowDef {
  const { def: without, removed } = removeStepBridging(def, stepId);
  if (!removed) return def;
  const g = without.groups.find((x) => x.id === groupId);
  const at = Math.max(0, Math.min(index, g?.steps.length ?? 0));
  const before = g?.steps[at - 1];
  return insertStepAt(without, groupId, at, removed, before ? [before.id] : []).def;
}

/** Duplicate a step so that the copy runs right after the original and the original's dependents wait for the copy. */
export function duplicateStep(def: WorkflowDef, stepId: string, copy: StepDef): { def: WorkflowDef; step: StepDef } | null {
  const n = materializeDeps(clone(def));
  const g = n.groups.find((x) => x.steps.some((s) => s.id === stepId));
  if (!g) return null;
  const at = g.steps.findIndex((s) => s.id === stepId);
  const added: StepDef = { ...copy, dependsOn: [stepId] };
  for (const s of g.steps) if (s.dependsOn?.includes(stepId)) s.dependsOn = s.dependsOn.map((d) => (d === stepId ? added.id : d));
  g.steps.splice(at + 1, 0, added);
  return { def: n, step: added };
}
