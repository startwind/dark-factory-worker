import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ARTIFACT_LIMITS } from '@nova/shared';
import { collectArtifacts } from './artifacts.js';
import { describeMissing, detectTools, type ShellRunner } from './tools.js';

describe('tool detection', () => {
  const fake = (have: Record<string, string>): ShellRunner => async (script) => {
    const hit = Object.entries(have).find(([k]) => script.startsWith(k));
    return hit ? { code: 0, stdout: `${hit[1]}\nmore`, stderr: '' } : { code: 127, stdout: '', stderr: 'not found' };
  };
  it('reports availability and the first output line as version', async () => {
    const r = await detectTools(fake({ 'git --version': 'git version 2.45.0', 'node --version': 'v22.1.0' }), ['git', 'node', 'jq']);
    expect(r.map((t) => [t.id, t.available, t.version])).toEqual([['git', true, 'git version 2.45.0'], ['node', true, 'v22.1.0'], ['jq', false, null]]);
  });
  it('checks the whole catalog by default and ignores unknown ids', async () => {
    expect((await detectTools(fake({}))).every((t) => !t.available)).toBe(true);
    expect(await detectTools(fake({}), ['nope'])).toEqual([]);
  });
  it('describes missing tools with their install hint', () => {
    expect(describeMissing(['playwright', 'zzz'])).toMatch(/Playwright \[playwright\] - .*install.*; zzz \(not in the tool catalog\)/s);
  });
});

describe('artifact collection', () => {
  const ws = () => {
    const d = mkdtempSync(join(tmpdir(), 'nova-art-'));
    mkdirSync(join(d, '.nova/screenshots/before'), { recursive: true });
    mkdirSync(join(d, '.nova/screenshots/after'), { recursive: true });
    writeFileSync(join(d, '.nova/screenshots/before/home.png'), 'png-before');
    writeFileSync(join(d, '.nova/screenshots/after/home.png'), 'png-after');
    writeFileSync(join(d, '.nova/screenshots/plan.json'), '[]');
    writeFileSync(join(d, 'secret.txt'), 'nope');
    return d;
  };
  it('finds files below dot directories by glob and sets the mime type', async () => {
    const r = await collectArtifacts(ws(), ['.nova/screenshots/before/**', '.nova/screenshots/plan.json']);
    expect(r.files.map((f) => [f.path, f.mime])).toEqual([['.nova/screenshots/before/home.png', 'image/png'], ['.nova/screenshots/plan.json', 'application/json']]);
    expect(r.files[0].data.toString()).toBe('png-before');
  });
  it('never leaves the workspace', async () => {
    const d = ws();
    expect((await collectArtifacts(d, ['../**', '/etc/passwd', '../../etc/*'])).files).toEqual([]);
  });
  it('skips files over the size limit and says so', async () => {
    const d = ws();
    writeFileSync(join(d, 'big.bin'), Buffer.alloc(ARTIFACT_LIMITS.maxFileBytes + 1));
    const r = await collectArtifacts(d, ['*.bin', 'secret.txt']);
    expect(r.files.map((f) => f.path)).toEqual(['secret.txt']);
    expect(r.skipped.join()).toMatch(/big\.bin/);
  });
});
