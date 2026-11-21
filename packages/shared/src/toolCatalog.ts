import type { ResolvedWorkflow, StepDef } from './workflow.js';

/**
 * Tool catalog: the standard set of tools a worker reports and a step can depend on (`StepDef.requiresTools`).
 * Entries are plain data; the worker runs each `check` and reports what it found. To add a tool, append a `tool(...)` below.
 *
 * scope:
 *  - `host`      the worker itself needs it on its machine (git clones, podman runs the containers, gh talks to GitHub),
 *                independent of whether a job runs in a container or not.
 *  - `workspace` a step needs it where the step runs: inside the project's container when the repo has a Dockerfile,
 *                else on the worker host. The worker reports what its HOST has; for container jobs it re-checks inside the
 *                container when the job starts (the Dockerfile has to provide the tool).
 */
export type ToolScope = 'host' | 'workspace';
export const TOOL_CATEGORIES = ['Source control', 'Runtime', 'Browser', 'Utility'] as const;
export type ToolCategory = (typeof TOOL_CATEGORIES)[number];

export interface ToolDef {
  /** stable id used in `requiresTools` */
  id: string;
  label: string;
  description: string;
  category: ToolCategory;
  scope: ToolScope;
  /** shell command: exit code 0 = the tool is usable; the first output line is reported as its version */
  check: string;
  /** how to install it (shown in the web app when a worker lacks the tool) */
  hint: string;
}

const tool = (t: ToolDef): ToolDef => t;

export const TOOL_CATALOG: ToolDef[] = [
  tool({ id: 'git', label: 'git', description: 'Clones the repository and manages the ticket branch.', category: 'Source control', scope: 'host', check: 'git --version', hint: 'Install git (brew install git / apt install git).' }),
  tool({ id: 'gh', label: 'GitHub CLI', description: 'GitHub from the command line (gh), e.g. for pull requests.', category: 'Source control', scope: 'host', check: 'gh --version', hint: 'Install the GitHub CLI (brew install gh) and log in with: gh auth login.' }),
  tool({ id: 'podman', label: 'Podman', description: 'Container runtime for repositories with a Dockerfile (docker works as well).', category: 'Runtime', scope: 'host', check: 'podman --version || docker --version', hint: 'Install Podman (brew install podman) or Docker.' }),
  tool({ id: 'node', label: 'Node.js', description: 'JavaScript runtime.', category: 'Runtime', scope: 'workspace', check: 'node --version', hint: 'Install Node.js (host) or add it to the project Dockerfile (container).' }),
  tool({ id: 'npm', label: 'npm', description: 'Node package manager (npm test, npm run build …).', category: 'Runtime', scope: 'workspace', check: 'npm --version', hint: 'npm ships with Node.js.' }),
  tool({ id: 'python', label: 'Python 3', description: 'Python interpreter.', category: 'Runtime', scope: 'workspace', check: 'python3 --version', hint: 'Install Python 3 (host) or add it to the project Dockerfile (container).' }),
  tool({ id: 'playwright', label: 'Playwright', description: 'Browser automation (screenshots, UI tests). Needs a browser: npx playwright install chromium.', category: 'Browser', scope: 'workspace', check: '(playwright --version || npx --no-install playwright --version) 2>/dev/null', hint: 'npm i -D playwright && npx playwright install --with-deps chromium (host), or add both to the project Dockerfile (container).' }),
  tool({ id: 'chromium', label: 'Chromium', description: 'A Chromium/Chrome browser binary on the PATH.', category: 'Browser', scope: 'workspace', check: 'chromium --version || chromium-browser --version || google-chrome --version', hint: 'Install Chromium (apt install chromium) or add it to the project Dockerfile.' }),
  tool({ id: 'curl', label: 'curl', description: 'HTTP client, e.g. to wait until a dev server answers.', category: 'Utility', scope: 'workspace', check: 'curl --version', hint: 'Install curl.' }),
  tool({ id: 'jq', label: 'jq', description: 'JSON processor for shell scripts.', category: 'Utility', scope: 'workspace', check: 'jq --version', hint: 'Install jq (brew install jq / apt install jq).' }),
];

export const TOOL_IDS: string[] = TOOL_CATALOG.map((t) => t.id);
export const toolDef = (id: string): ToolDef | undefined => TOOL_CATALOG.find((t) => t.id === id);
export const toolLabel = (id: string): string => toolDef(id)?.label ?? id;

/** What a worker reports for one catalog tool. */
export interface WorkerToolInfo {
  id: string;
  available: boolean;
  version?: string | null;
  checkedAt: string;
}

/** Tools the steps of a workflow depend on, deduplicated. Unknown ids are kept (they will simply never be satisfied). */
export function requiredToolIds(steps: Pick<StepDef, 'requiresTools'>[]): string[] {
  return [...new Set(steps.flatMap((s) => s.requiresTools ?? []))];
}

/**
 * Tools the SCHEDULER can match against what a worker reports from its host:
 * host-scope tools always; workspace-scope tools only when the job runs on the host (repo without Dockerfile) -
 * for a container job the project image provides them, which the worker verifies inside the container.
 */
export function schedulingToolIds(wf: Pick<ResolvedWorkflow, 'steps'>, containerized: boolean): string[] {
  return requiredToolIds(wf.steps).filter((id) => !containerized || (toolDef(id)?.scope ?? 'workspace') === 'host');
}

/** Required tools that are not in the available set. */
export function missingTools(required: string[], available: Iterable<string>): string[] {
  const have = new Set(available);
  return required.filter((id) => !have.has(id));
}
