import { describe, expect, it } from 'vitest';
import { missingTools, requiredToolIds, schedulingToolIds, TOOL_CATALOG, TOOL_IDS, toolDef } from './toolCatalog.js';
import { StepDefSchema, validateWorkflowDef } from './workflow.js';

const step = (id: string, extra: object = {}) => StepDefSchema.parse({ id, name: id, type: 'SHELL', command: 'true', ...extra });

describe('tool catalog', () => {
  it('has unique ids, a check command and a hint for every tool', () => {
    expect(new Set(TOOL_IDS).size).toBe(TOOL_CATALOG.length);
    for (const t of TOOL_CATALOG) { expect(t.check).toBeTruthy(); expect(t.hint).toBeTruthy(); expect(['host', 'workspace']).toContain(t.scope); }
  });

  it('steps default to no requirements and no artifacts', () => {
    const s = step('a');
    expect(s.requiresTools).toEqual([]);
    expect(s.artifacts).toEqual([]);
  });

  it('collects the required tools of a workflow without duplicates', () => {
    expect(requiredToolIds([step('a', { requiresTools: ['node', 'git'] }), step('b', { requiresTools: ['node', 'playwright'] }), step('c')]).sort()).toEqual(['git', 'node', 'playwright']);
  });

  it('the scheduler only matches host tools for container jobs, all tools for host jobs', () => {
    const wf = { steps: [step('a', { requiresTools: ['git', 'gh', 'playwright', 'node'] })] } as never;
    expect(schedulingToolIds(wf, true).sort()).toEqual(['gh', 'git']);
    expect(schedulingToolIds(wf, false).sort()).toEqual(['gh', 'git', 'node', 'playwright']);
    expect(toolDef('playwright')?.scope).toBe('workspace');
  });

  it('reports what is missing', () => {
    expect(missingTools(['git', 'node', 'jq'], ['git', 'jq'])).toEqual(['node']);
  });

  it('validation rejects unknown tools and artifact patterns outside the workspace', () => {
    const wf = (s: object) => ({ groups: [{ id: 'g', name: 'G', steps: [step('a', s)] }] });
    expect(validateWorkflowDef(wf({ requiresTools: ['node'], artifacts: ['.nova/out/**'] }))).toEqual([]);
    expect(validateWorkflowDef(wf({ requiresTools: ['nope'] })).join()).toMatch(/unknown tool "nope"/);
    expect(validateWorkflowDef(wf({ artifacts: ['/etc/passwd'] })).join()).toMatch(/relative to the workspace/);
    expect(validateWorkflowDef(wf({ artifacts: ['../x/**'] })).join()).toMatch(/relative to the workspace/);
  });
});
