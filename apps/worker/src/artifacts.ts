import { readFileSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { glob } from 'tinyglobby';
import { ARTIFACT_LIMITS } from '@nova/shared';

const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.txt': 'text/plain', '.log': 'text/plain', '.md': 'text/markdown', '.html': 'text/html', '.csv': 'text/csv', '.pdf': 'application/pdf',
  '.webm': 'video/webm', '.mp4': 'video/mp4',
};
export const mimeOf = (path: string) => MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';

export interface CollectedArtifact { path: string; mime: string; data: Buffer }
export interface CollectResult { files: CollectedArtifact[]; skipped: string[] }

/**
 * Finds the files a step declared as artifacts (glob patterns relative to the workspace) and reads them.
 * Patterns that point outside the workspace are ignored; files over the size limit and files beyond the per-step count are skipped
 * (and reported), never silently truncated.
 */
export async function collectArtifacts(workspace: string, patterns: string[]): Promise<CollectResult> {
  const safe = patterns.filter((p) => !p.startsWith('/') && !p.split('/').includes('..'));
  const skipped: string[] = [];
  if (!safe.length) return { files: [], skipped };
  const hits = await glob(safe, { cwd: workspace, dot: true, onlyFiles: true, followSymbolicLinks: false, absolute: false });
  const files: CollectedArtifact[] = [];
  for (const rel of [...new Set(hits)].sort()) {
    const abs = join(workspace, rel);
    if (relative(workspace, abs).startsWith('..')) continue; // belt and braces
    let size: number;
    try { size = statSync(abs).size; } catch { continue; }
    if (size > ARTIFACT_LIMITS.maxFileBytes) { skipped.push(`${rel} (${Math.round(size / 1024)} kB is over the ${ARTIFACT_LIMITS.maxFileBytes / 1024 / 1024} MB limit)`); continue; }
    if (files.length >= ARTIFACT_LIMITS.maxFilesPerStep) { skipped.push(`${rel} (more than ${ARTIFACT_LIMITS.maxFilesPerStep} files)`); continue; }
    files.push({ path: rel.split(sep).join('/'), mime: mimeOf(rel), data: readFileSync(abs) });
  }
  return { files, skipped };
}
