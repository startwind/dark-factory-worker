export const RUN_STATUSES = ['QUEUED', 'ASSIGNED', 'RUNNING', 'WAITING_APPROVAL', 'STOPPING', 'COMPLETED', 'FAILED', 'STOPPED'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const ACTIVE_RUN_STATUSES: RunStatus[] = ['ASSIGNED', 'RUNNING', 'WAITING_APPROVAL', 'STOPPING'];
export const TERMINAL_RUN_STATUSES: RunStatus[] = ['COMPLETED', 'FAILED', 'STOPPED'];

export const STEP_STATUSES = ['PENDING', 'QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'STOPPED'] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export const PRIORITY_RANK: Record<string, number> = { Highest: 5, High: 4, Medium: 3, Low: 2, Lowest: 1 };
export function priorityRank(p?: string | null): number {
  return (p && PRIORITY_RANK[p]) || 3;
}
