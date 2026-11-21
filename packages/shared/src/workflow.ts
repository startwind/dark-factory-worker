import { z } from 'zod';
import { RESERVED_OUTPUT_KEYS } from './output.js';
import { TOOL_IDS } from './toolCatalog.js';
import type { StatusTargets } from './statusMapping.js';

export const OutputTypeSchema = z.enum(['string', 'number', 'boolean', 'array', 'object']);
export type OutputType = z.infer<typeof OutputTypeSchema>;

export const ExpectedOutputSchema = z.object({
  key: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, 'key must be an identifier'),
  type: OutputTypeSchema,
  required: z.boolean().default(true),
  instruction: z.string().default(''),
  /** numeric outputs are metrics: show them as chips in the run overview (step box) */
  showInOverview: z.boolean().default(true),
});
export type ExpectedOutput = z.infer<typeof ExpectedOutputSchema>;

export const SkillRefSchema = z.object({
  id: z.string(), // stable unique id, e.g. "repository:.claude/skills/security-audit" or "marketplace:acme/security-audit"
  name: z.string(),
  source: z.enum(['repository', 'marketplace']),
  path: z.string().optional(), // repo path or marketplace reference
  version: z.string().optional(), // commit sha / marketplace version
});
export type SkillRef = z.infer<typeof SkillRefSchema>;

export const StepTypeSchema = z.enum(['AI_PROMPT', 'KOAN_BOT', 'SHELL', 'HUMAN_APPROVAL', 'PULL_REQUEST']);
export type StepType = z.infer<typeof StepTypeSchema>;

/** Kōan Bot skills a KOAN_BOT step can invoke (the bot has 44+ commands; these are the ones documented publicly). */
export const KOAN_COMMANDS = [
  { key: 'fix', label: '/fix', description: 'Targeted bug fix: finds the cause, fixes it in its own branch.' },
  { key: 'implement', label: '/implement', description: 'Writes the code for a feature or a fix.' },
  { key: 'plan', label: '/plan', description: 'Turns an idea into a short, ordered plan and flags risky steps.' },
  { key: 'review', label: '/review', description: 'Audits the diff and the code around it; reports findings.' },
  { key: 'rebase', label: '/rebase', description: 'Brings the branch up to date with its base branch.' },
  { key: 'autopilot', label: '/autopilot', description: 'Loops review, fix and push until nothing is left to flag.' },
  { key: 'sparring', label: '/sparring', description: 'Challenges the plan or idea (strategy, no code).' },
] as const;
export const DEFAULT_KOAN_COMMAND = 'fix';

export const ErrorBehaviorSchema = z.object({
  mode: z.enum(['stop', 'retry']).default('stop'),
  maxRetries: z.number().int().min(0).max(5).default(1),
});
export type ErrorBehavior = z.infer<typeof ErrorBehaviorSchema>;

/**
 * "Send back": where the workflow continues when this step finds problems. By default nothing happens (it just goes on,
 * or stops when the step really fails). With `goToStepId` the workflow jumps BACK to that earlier step and hands this step's
 * output along as feedback (e.g. QA/security scan reports findings -> back to Implementation, which fixes them).
 * Triggers: an AI step reports `needs_rework: true` (it still succeeds - it only reports) or the step fails
 * (e.g. a shell command exits non-zero). `maxLoops` bounds how often this step may send the workflow back.
 */
export const SendBackSchema = z.object({
  /** go back to this earlier (AI) step ... */
  goToStepId: z.string().nullable().default(null),
  /** ... or to the start of this earlier group (all its AI steps get the feedback). Only one of the two is set. */
  goToGroupId: z.string().nullable().default(null),
  maxLoops: z.number().int().min(1).max(10).default(3),
});
export type SendBack = z.infer<typeof SendBackSchema>;

export const StepDefSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  description: z.string().default(''),
  type: StepTypeSchema,
  prompt: z.string().default(''),
  command: z.string().default(''),
  /** KOAN_BOT only: the Kōan skill to run (key of KOAN_COMMANDS); the step's `prompt` is the task text */
  koanCommand: z.string().default('fix'),
  /** null = use project default agent (key of AgentType) */
  agentKey: z.string().nullable().default(null),
  skills: z.array(SkillRefSchema).default([]),
  expectedOutputs: z.array(ExpectedOutputSchema).default([]),
  jiraComment: z.boolean().default(false),
  onError: ErrorBehaviorSchema.default({ mode: 'stop', maxRetries: 1 }),
  sendBack: SendBackSchema.default({ goToStepId: null, goToGroupId: null, maxLoops: 3 }),
  /**
   * Dependencies: ids of EARLIER steps of the same group that must be completed before this step starts.
   * Not set = after the previous step of the group (the classic sequential flow); `[]` = no dependency, so the step can start
   * as soon as its group starts - and run in parallel with other steps that have no (open) dependencies.
   * The worker decides how many steps it really runs at the same time.
   */
  dependsOn: z.array(z.string()).optional(),
  /**
   * Tools (ids of the tool catalog) this step needs. A run is only given to a worker that reports all of them; for container jobs
   * the worker re-checks inside the project container before the first step.
   */
  requiresTools: z.array(z.string()).default([]),
  /**
   * Files the step produces and that should be kept with the run (screenshots, reports ...): glob patterns relative to the
   * workspace, e.g. `.nova/screenshots/after/**`. The worker uploads the matches after the step finished.
   */
  artifacts: z.array(z.string().min(1).max(200)).max(10).default([]),
  timeoutSec: z.number().int().min(10).max(24 * 3600).default(1800),
});
export type StepDef = z.infer<typeof StepDefSchema>;

export const GroupDefSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  steps: z.array(StepDefSchema),
  /**
   * Send back for the whole group: ALL its steps run first (a step that reports findings or fails does not interrupt it),
   * then - if any step had findings - the workflow goes back with the findings of all steps.
   */
  sendBack: SendBackSchema.optional(),
});
export type GroupDef = z.infer<typeof GroupDefSchema>;

export const WorkflowDefSchema = z.object({ groups: z.array(GroupDefSchema) });
export type WorkflowDef = z.infer<typeof WorkflowDefSchema>;

/** Effective dependencies of `steps[index]` within its group (only earlier steps of that group count). */
export function stepDependencies(steps: { id: string; dependsOn?: string[] }[], index: number): string[] {
  const s = steps[index];
  if (s.dependsOn) return [...new Set(s.dependsOn)].filter((id) => steps.some((x, j) => j < index && x.id === id));
  return index > 0 ? [steps[index - 1].id] : [];
}

/** Row of every step when a group is drawn: 0 = no dependencies, else 1 + the deepest dependency. Steps in the same row can run in parallel. */
export function stepLevels(steps: { id: string; dependsOn?: string[] }[]): number[] {
  const level: number[] = [];
  steps.forEach((s, i) => {
    const deps = stepDependencies(steps, i);
    level[i] = deps.length ? 1 + Math.max(...deps.map((d) => level[steps.findIndex((x) => x.id === d)])) : 0;
  });
  return level;
}

/** Validate semantic rules of a workflow (MVP: linear, PR step only at the very end). */
export function validateWorkflowDef(def: WorkflowDef): string[] {
  const errors: string[] = [];
  const all = def.groups.flatMap((g) => g.steps.map((s) => ({ g, s })));
  if (all.length === 0) errors.push('Workflow has no steps');
  const ids = new Set<string>();
  for (const { s } of all) {
    if (ids.has(s.id)) errors.push(`Duplicate step id ${s.id}`);
    ids.add(s.id);
    if (s.type === 'AI_PROMPT' && !s.prompt.trim()) errors.push(`Step "${s.name}": prompt is empty`);
    if (s.type === 'KOAN_BOT' && !s.prompt.trim()) errors.push(`Step "${s.name}": the task for Kōan is empty`);
    if (s.type === 'KOAN_BOT' && !KOAN_COMMANDS.some((c) => c.key === s.koanCommand)) errors.push(`Step "${s.name}": unknown Kōan command "${s.koanCommand}"`);
    if (s.type === 'SHELL' && !s.command.trim()) errors.push(`Step "${s.name}": command is empty`);
    for (const t of s.requiresTools) if (!TOOL_IDS.includes(t)) errors.push(`Step "${s.name}": unknown tool "${t}" (see the tool catalog)`);
    for (const a of s.artifacts) if (a.startsWith('/') || a.split('/').includes('..')) errors.push(`Step "${s.name}": artifact pattern "${a}" must be relative to the workspace (no leading / and no ..)`);
    const keys = new Set<string>();
    for (const o of s.expectedOutputs) {
      if ((RESERVED_OUTPUT_KEYS as readonly string[]).includes(o.key)) errors.push(`Step "${s.name}": "${o.key}" is a reserved result field (needs_rework, rework_notes and observations are standard fields of every AI step)`);
      if (keys.has(o.key)) errors.push(`Step "${s.name}": duplicate output key ${o.key}`);
      keys.add(o.key);
    }
  }
  // "send back" routes of steps and groups: only to EARLIER AI steps / groups
  const firstIdx = new Map<string, number>();
  all.forEach(({ g }, i) => { if (!firstIdx.has(g.id)) firstIdx.set(g.id, i); });
  const checkRoute = (owner: string, route: SendBack | undefined, ownerIdx: number) => {
    if (!route || (!route.goToStepId && !route.goToGroupId)) return;
    if (route.goToStepId && route.goToGroupId) { errors.push(`${owner}: choose either a step or a group to go back to, not both`); return; }
    if (route.goToStepId) {
      const ti = all.findIndex((x) => x.s.id === route.goToStepId);
      if (ti < 0) errors.push(`${owner}: the step to go back to does not exist`);
      else if (ti >= ownerIdx) errors.push(`${owner}: "send back to" can only point to an EARLIER step`);
      else if (all[ti].s.type !== 'AI_PROMPT') errors.push(`${owner}: it can only go back to an AI step ("${all[ti].s.name}" is not one), because only AI steps can use the feedback`);
    } else {
      const gi = firstIdx.get(route.goToGroupId!);
      const gs = all.filter((x) => x.g.id === route.goToGroupId);
      if (gi === undefined) errors.push(`${owner}: the group to go back to does not exist`);
      else if (gi >= ownerIdx) errors.push(`${owner}: "send back to" can only point to an EARLIER group`);
      else if (!gs.some((x) => x.s.type === 'AI_PROMPT')) errors.push(`${owner}: group "${gs[0].g.name}" has no AI step that could use the feedback`);
    }
  };
  all.forEach(({ s }, i) => checkRoute(`Step "${s.name}"`, s.sendBack, i));
  for (const g of def.groups) if (g.steps.length) checkRoute(`Group "${g.name}"`, g.sendBack, firstIdx.get(g.id)!);
  // dependencies: only on EARLIER steps of the same group, no duplicates, no self reference
  for (const g of def.groups) {
    g.steps.forEach((s, i) => {
      if (!s.dependsOn) return;
      const seen = new Set<string>();
      for (const d of s.dependsOn) {
        if (d === s.id) errors.push(`Step "${s.name}": a step cannot depend on itself`);
        else if (seen.has(d)) errors.push(`Step "${s.name}": duplicate dependency`);
        else if (!g.steps.some((x, j) => j < i && x.id === d)) errors.push(`Step "${s.name}": it can only depend on EARLIER steps of its own group`);
        seen.add(d);
      }
    });
  }
  all.forEach(({ g, s }, i) => {
    if (s.type !== 'PULL_REQUEST') return;
    if (i !== all.length - 1) errors.push(`Step "${s.name}": the Pull Request step must be the last step (MVP)`);
    // it publishes everything: all other steps of its group must have finished before it starts
    const gs = g.steps;
    const idx = gs.findIndex((x) => x.id === s.id);
    const ancestors = new Set<string>();
    const walk = (k: number) => { for (const d of stepDependencies(gs, k)) if (!ancestors.has(d)) { ancestors.add(d); walk(gs.findIndex((x) => x.id === d)); } };
    walk(idx);
    const missing = gs.filter((x, j) => j !== idx && !ancestors.has(x.id));
    if (missing.length) errors.push(`Step "${s.name}": the Pull Request step has to wait for all other steps of its group (add: ${missing.map((m) => `"${m.name}"`).join(', ')})`);
  });
  return errors;
}

/** A step with agent + Jira status resolved at run start. Immutable for the run's lifetime. */
export interface ResolvedStep extends StepDef {
  groupId: string;
  groupName: string;
  index: number;
  /** Agent key after applying override > project default. null for non-AI steps */
  resolvedAgentKey: string | null;
  agentSource: 'override' | 'project-default' | null;
}
export interface ResolvedGroup {
  id: string;
  name: string;
  jiraStatus: string | null;
  /** older frozen runs have none */
  sendBack?: SendBack;
}
export interface ResolvedWorkflow {
  workflowId: string;
  workflowName: string;
  versionId: string;
  version: number;
  groups: ResolvedGroup[];
  steps: ResolvedStep[];
  /** status mapping frozen for this run (absent: legacy group-name mapping via ResolvedGroup.jiraStatus) */
  statusTargets?: StatusTargets;
}
