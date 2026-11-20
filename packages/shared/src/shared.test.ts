import { describe, expect, it } from 'vitest';
import { buildJsonSchema, extractJsonFromText, extractMetrics, extractObservation, validateOutput } from './output.js';
import { StepDefSchema, validateWorkflowDef } from './workflow.js';
import { makeRedactor } from './redact.js';
import { fingerprint, generateIdentity, signChallenge, verifyChallenge } from './identity.js';

const outputs = [
  { key: 'findings_count', type: 'number' as const, required: true, instruction: 'count' },
  { key: 'summary', type: 'string' as const, required: true, instruction: '' },
  { key: 'tags', type: 'array' as const, required: false, instruction: '' },
];

describe('expected output validation', () => {
  it('accepts valid output and extracts metrics', () => {
    const r = validateOutput('{"findings_count":5,"summary":"ok"}', outputs);
    expect(r.ok).toBe(true);
    expect(extractMetrics(r.data!, outputs)).toEqual({ findings_count: 5 });
  });
  it('reports invalid JSON', () => {
    const r = validateOutput('{nope', outputs);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/Invalid JSON/);
  });
  it('reports missing required and wrong types', () => {
    const r = validateOutput({ findings_count: 'five' }, outputs);
    expect(r.ok).toBe(false);
    expect(r.errors.join('|')).toMatch(/summary/);
    expect(r.errors.join('|')).toMatch(/number/);
  });
  it('rejects non-object results', () => {
    expect(validateOutput('[1]', outputs).ok).toBe(false);
  });
  it('treats observations as optional system field; empty means none', () => {
    expect(extractObservation({ observations: '  ' })).toBeNull();
    expect(extractObservation({ observations: 'new dependency' })).toBe('new dependency');
    expect(extractObservation({})).toBeNull();
  });
  it('builds JSON schema with required list', () => {
    expect((buildJsonSchema(outputs) as { required: string[] }).required).toEqual(['findings_count', 'summary']);
  });
  it('extracts JSON from free text', () => {
    expect(extractJsonFromText('blah NOVA_RESULT_BEGIN {"a":1} NOVA_RESULT_END')).toBe('{"a":1}');
    expect(extractJsonFromText('done\n```json\n{"a":2}\n```')).toBe('{"a":2}');
    expect(extractJsonFromText('log {"a":3}')).toBe('{"a":3}');
    expect(extractJsonFromText('nothing')).toBeNull();
  });
});

describe('workflow definition rules', () => {
  const s = (id: string, type: 'AI_PROMPT' | 'PULL_REQUEST') => StepDefSchema.parse({ id, name: id, type, prompt: 'x' });
  it('requires PR step to be last', () => {
    expect(validateWorkflowDef({ groups: [{ id: 'g', name: 'g', steps: [s('pr', 'PULL_REQUEST'), s('a', 'AI_PROMPT')] }] }).join()).toMatch(/last step/);
    expect(validateWorkflowDef({ groups: [{ id: 'g', name: 'g', steps: [s('a', 'AI_PROMPT'), s('pr', 'PULL_REQUEST')] }] })).toEqual([]);
  });
  it('rejects empty prompts', () => {
    expect(validateWorkflowDef({ groups: [{ id: 'g', name: 'g', steps: [StepDefSchema.parse({ id: 'a', name: 'a', type: 'AI_PROMPT' })] }] }).join()).toMatch(/prompt is empty/);
  });
});

describe('redaction + identity', () => {
  it('redacts tokens and literal secrets', () => {
    const r = makeRedactor(['hunter2-secret']);
    expect(r('token ghp_abcdefghijklmnopqrstuvwxyz0123 and hunter2-secret')).toBe('token *** and ***');
    expect(r('https://x:supersecret@github.com/a/b')).toBe('https://x:***@github.com/a/b');
  });
  it('signs and verifies challenges bound to the key', () => {
    const a = generateIdentity();
    const b = generateIdentity();
    const sig = signChallenge(a, 'nonce-1');
    expect(verifyChallenge(a.publicKey, 'nonce-1', sig)).toBe(true);
    expect(verifyChallenge(a.publicKey, 'nonce-2', sig)).toBe(false);
    expect(verifyChallenge(b.publicKey, 'nonce-1', sig)).toBe(false);
    expect(fingerprint(a.publicKey)).not.toBe(fingerprint(b.publicKey));
  });
});
