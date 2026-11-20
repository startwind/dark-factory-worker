import type { ResolvedWorkflow, ResolvedStep, StatusTargets, WorkflowDef } from '@nova/shared';

export interface ResolveContext {
  workflowId: string;
  workflowName: string;
  versionId: string;
  version: number;
  /** AgentType key of the project's default agent */
  projectDefaultAgentKey: string;
  /** group name -> ticket status name (per project); legacy field name */
  jiraStatusMap: Record<string, string>;
  /** status mapping of the project (stable ids); wins over the legacy name map */
  statusTargets?: StatusTargets;
}

/**
 * Freezes a workflow definition for a run: applies agent resolution
 * (step override > project default) and Jira status mapping.
 * The result is stored with the run, so later template/project changes never affect it.
 */
export function resolveWorkflow(def: WorkflowDef, ctx: ResolveContext): ResolvedWorkflow {
  const steps: ResolvedStep[] = [];
  let index = 0;
  for (const g of def.groups) {
    for (const s of g.steps) {
      const isAi = s.type === 'AI_PROMPT';
      steps.push({
        ...s,
        groupId: g.id,
        groupName: g.name,
        index: index++,
        resolvedAgentKey: isAi ? (s.agentKey ?? ctx.projectDefaultAgentKey) : null,
        agentSource: isAi ? (s.agentKey ? 'override' : 'project-default') : null,
      });
    }
  }
  return {
    workflowId: ctx.workflowId,
    workflowName: ctx.workflowName,
    versionId: ctx.versionId,
    version: ctx.version,
    groups: def.groups.map((g) => ({ id: g.id, name: g.name, jiraStatus: ctx.statusTargets ? (ctx.statusTargets.groups[g.id] ?? null) : (ctx.jiraStatusMap[g.name] ?? null), sendBack: g.sendBack })),
    steps,
    ...(ctx.statusTargets ? { statusTargets: ctx.statusTargets } : {}),
  };
}

export function requiredAgentKeys(wf: ResolvedWorkflow): string[] {
  return [...new Set(wf.steps.map((s) => s.resolvedAgentKey).filter((k): k is string => !!k))];
}
