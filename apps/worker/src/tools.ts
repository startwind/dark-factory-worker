import { TOOL_CATALOG, toolDef, type ToolDef, type WorkerToolInfo } from '@nova/shared';
import { run, withPath, type RunResult } from './proc.js';

/** Runs a shell command in the environment a tool must be present in (host shell or the job container). */
export type ShellRunner = (script: string) => Promise<Pick<RunResult, 'code' | 'stdout' | 'stderr'>>;

export const hostShell: ShellRunner = (script) => run('sh', ['-lc', script], { env: withPath(), timeoutMs: 20_000 });

const firstLine = (s: string) => s.split('\n').map((l) => l.trim()).find(Boolean)?.slice(0, 120) ?? null;

/** Checks one catalog tool: exit code 0 = usable, the first output line is its version. */
export async function detectTool(def: ToolDef, sh: ShellRunner): Promise<WorkerToolInfo> {
  const r = await sh(def.check);
  const ok = r.code === 0;
  return { id: def.id, available: ok, version: ok ? firstLine(r.stdout) ?? firstLine(r.stderr) : null, checkedAt: new Date().toISOString() };
}

/** Checks the given tools (default: the whole catalog) in parallel. */
export async function detectTools(sh: ShellRunner = hostShell, ids?: string[]): Promise<WorkerToolInfo[]> {
  const defs = ids ? ids.map((id) => toolDef(id)).filter((d): d is ToolDef => !!d) : TOOL_CATALOG;
  return Promise.all(defs.map((d) => detectTool(d, sh)));
}

/** Human readable "<label> (<how to install>)" lines for tools that are missing. Unknown ids are reported as such. */
export function describeMissing(ids: string[]): string {
  return ids.map((id) => { const d = toolDef(id); return d ? `${d.label} [${id}] - ${d.hint}` : `${id} (not in the tool catalog)`; }).join('; ');
}
