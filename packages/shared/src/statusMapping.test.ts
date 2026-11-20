import { describe, expect, it } from 'vitest';
import { StatusMappingSchema, mappingConflicts, mappingRows, resolveStatusTargets, autoStatusValue } from './statusMapping.js';
import { WorkflowDefSchema } from './workflow.js';

const def = WorkflowDefSchema.parse({ groups: [
  { id: 'g1', name: 'In Progress', steps: [{ id: 's1', name: 'Implement', type: 'AI_PROMPT', prompt: 'x' }, { id: 's2', name: 'Test', type: 'SHELL', command: 'npm t' }] },
  { id: 'g2', name: 'Code Review', steps: [{ id: 's3', name: 'Review', type: 'AI_PROMPT', prompt: 'x' }] },
] });
const wfs = [{ name: 'W', def }];

describe('status mapping', () => {
  it('defaults: auto, group level, "f:group:" prefix', () => {
    const m = StatusMappingSchema.parse({ field: 'labels' });
    expect([m.mode, m.level, m.prefix]).toEqual(['auto', 'group', 'f:group:']);
    expect(mappingRows(m, wfs).map((r) => r.value)).toEqual(['f:group:in-progress', 'f:group:code-review']);
  });
  it('step level uses step names', () => {
    const m = StatusMappingSchema.parse({ field: 'labels', level: 'step', prefix: '' });
    expect(mappingRows(m, wfs).map((r) => r.value)).toEqual(['implement', 'test', 'review']);
  });
  it('manual mode references ids; unmapped stays null; rename does not matter', () => {
    const m = StatusMappingSchema.parse({ field: 'labels', mode: 'manual', manual: { g1: 'development' } });
    expect(mappingRows(m, wfs).map((r) => r.value)).toEqual(['development', null]);
    const renamed = { name: 'W', def: { groups: def.groups.map((g) => (g.id === 'g1' ? { ...g, name: 'Dev' } : g)) } };
    expect(mappingRows(m, [renamed]).map((r) => r.value)).toEqual(['development', null]);
  });
  it('auto mode follows a rename, history keeps the old value managed', () => {
    const m = StatusMappingSchema.parse({ field: 'labels', history: [autoStatusValue('f:group:', 'In Progress')] });
    const renamed = { groups: def.groups.map((g) => (g.id === 'g1' ? { ...g, name: 'Dev' } : g)) };
    const t = resolveStatusTargets(m, renamed, 'W');
    expect(t.groups.g1).toBe('f:group:dev');
    expect(t.managed).toContain('f:group:in-progress'); // old label is removed from existing tickets
    expect(t.managed).toContain('f:group:dev');
  });
  it('detects duplicate values within a workflow only', () => {
    const m = StatusMappingSchema.parse({ field: 'labels', mode: 'manual', manual: { g1: 'x', g2: 'X' } });
    expect(mappingConflicts(mappingRows(m, wfs))).toHaveLength(1);
    const other = [{ name: 'A', def: { groups: [def.groups[0]] } }, { name: 'B', def: { groups: [def.groups[1]] } }];
    expect(mappingConflicts(mappingRows(m, other))).toHaveLength(0);
  });
});
