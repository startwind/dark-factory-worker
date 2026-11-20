import { z } from 'zod';
import type { WorkflowDef } from './workflow.js';

/**
 * Status mapping: which value of an external tracker field reflects the factory's current group (or step).
 * Pure data + pure functions, no tracker knowledge: the connector decides what a "field" and a "value" are.
 * The mapping refers to groups/steps by their stable ID, never by name, so renames keep it intact.
 */
export const StatusMappingSchema = z.object({
  /** connector-defined field key, e.g. GitHub "labels", Jira "status" */
  field: z.string().min(1),
  /** auto: value derived from the group/step name; manual: user-chosen value per id */
  mode: z.enum(['auto', 'manual']).default('auto'),
  /** which internal status the tracker reflects; default group (fewer writes) */
  level: z.enum(['group', 'step']).default('group'),
  /** prefix of automatic values; keeps them apart from existing labels */
  prefix: z.string().max(40).default('f:group:'),
  /** manual mode: group/step id -> external value */
  manual: z.record(z.string()).default({}),
  /** every value the factory ever wrote (so a renamed automatic value is cleaned up on existing tickets) */
  history: z.array(z.string()).default([]),
  /** v1: the factory leads; reserved for a later bidirectional sync */
  direction: z.literal('factory-to-tracker').default('factory-to-tracker'),
});
export type StatusMapping = z.infer<typeof StatusMappingSchema>;

export interface MappingRow {
  kind: 'group' | 'step';
  id: string;
  name: string;
  workflowName: string;
  /** null = this status is not synchronised (manual mode, nothing chosen) */
  value: string | null;
}

/** "Technical Acceptance" -> "technical-acceptance" (label friendly) */
export const statusSlug = (name: string) => name.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
export const autoStatusValue = (prefix: string, name: string) => `${prefix}${statusSlug(name)}`;

/** The rows (group or step level) of the given workflows with their resulting external value. */
export function mappingRows(m: StatusMapping, workflows: { name: string; def: WorkflowDef }[]): MappingRow[] {
  const rows: MappingRow[] = [];
  for (const w of workflows) {
    for (const g of w.def.groups) {
      const items = m.level === 'group' ? [{ kind: 'group' as const, id: g.id, name: g.name }] : g.steps.map((s) => ({ kind: 'step' as const, id: s.id, name: s.name }));
      for (const it of items) {
        const value = m.mode === 'auto' ? autoStatusValue(m.prefix, it.name) : (m.manual[it.id]?.trim() || null);
        rows.push({ ...it, workflowName: w.name, value });
      }
    }
  }
  return rows;
}

/** Duplicate / contradicting assignments: within one workflow two different statuses must not share a value. */
export function mappingConflicts(rows: MappingRow[]): string[] {
  const errors: string[] = [];
  const byWf = new Map<string, MappingRow[]>();
  for (const r of rows) byWf.set(r.workflowName, [...(byWf.get(r.workflowName) ?? []), r]);
  for (const [wf, list] of byWf) {
    const seen = new Map<string, MappingRow>();
    for (const r of list) {
      if (!r.value) continue;
      const k = r.value.toLowerCase();
      const o = seen.get(k);
      if (o && o.id !== r.id) errors.push(`Workflow "${wf}": "${o.name}" and "${r.name}" both map to "${r.value}"`);
      else seen.set(k, r);
    }
  }
  return errors;
}

/** What gets frozen into a run: external value per group id / step id, plus every value the factory manages on a ticket. */
export interface StatusTargets {
  field: string;
  level: 'group' | 'step';
  groups: Record<string, string>;
  steps: Record<string, string>;
  /** all values of the mapping (and its history): everything except the current one is removed from a ticket */
  managed: string[];
}

export function resolveStatusTargets(m: StatusMapping, def: WorkflowDef, workflowName: string, allWorkflows: { name: string; def: WorkflowDef }[] = []): StatusTargets {
  const rows = mappingRows(m, [{ name: workflowName, def }]);
  const t: StatusTargets = { field: m.field, level: m.level, groups: {}, steps: {}, managed: [] };
  for (const r of rows) if (r.value) (r.kind === 'group' ? t.groups : t.steps)[r.id] = r.value;
  const every = mappingRows(m, allWorkflows.length ? allWorkflows : [{ name: workflowName, def }]).map((r) => r.value).filter((v): v is string => !!v);
  t.managed = [...new Set([...every, ...m.history, ...Object.values(t.groups), ...Object.values(t.steps)])];
  return t;
}

/** Values that are new to the history (call after a successful write / when saving the mapping). */
export const withHistory = (m: StatusMapping, values: string[]): StatusMapping => ({ ...m, history: [...new Set([...m.history, ...values])].slice(-200) });
