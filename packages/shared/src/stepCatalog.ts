import { StepDefSchema, type StepDef, type StepType } from './workflow.js';

/**
 * Step marketplace: ready-made workflow steps that can be added from the workflow editor
 * (or skipped in favour of a custom step). Entries are plain data; to add one, append a `tpl(...)` below.
 */
export const STEP_CATEGORIES = ['Development', 'Quality', 'Security', 'Process', 'Delivery'] as const;
export type StepCategory = (typeof STEP_CATEGORIES)[number];

export interface StepTemplate {
  /** stable id, e.g. "builtin/run-tests" */
  id: string;
  name: string;
  description: string;
  category: StepCategory;
  type: StepType;
  author: string;
  version: string;
  /** the step as it is inserted into a workflow (a fresh `id` is assigned on insert) */
  step: Omit<StepDef, 'id'>;
}

const out = (key: string, type: 'string' | 'number' | 'boolean', instruction: string, required = true) => ({ key, type, required, instruction, showInOverview: true });

function tpl(t: { id: string; category: StepCategory; description: string; step: Partial<StepDef> & Pick<StepDef, 'name' | 'type'> }): StepTemplate {
  const { id: _id, ...step } = StepDefSchema.parse({ id: 'template', ...t.step, description: t.description });
  return { id: `builtin/${t.id}`, name: step.name, description: t.description, category: t.category, type: step.type, author: 'Nova Factory', version: '1.0.0', step };
}

export const STEP_CATALOG: StepTemplate[] = [
  tpl({
    id: 'implement-feature', category: 'Development',
    description: 'Implements the ticket in the repository with minimal, focused changes.',
    step: {
      name: 'Implement Feature', type: 'AI_PROMPT', jiraComment: true,
      prompt: 'Implement the ticket in the repository. Read the relevant code first, follow the existing conventions and keep the change minimal and focused. Do not refactor unrelated code.',
      expectedOutputs: [out('files_changed', 'number', 'Number of files you changed'), out('summary', 'string', 'What you implemented and why')],
    },
  }),
  tpl({
    id: 'write-tests', category: 'Quality',
    description: 'Adds unit tests for the change: happy path, edge cases and failure modes.',
    step: {
      name: 'Write Tests', type: 'AI_PROMPT',
      prompt: 'Add automated tests for the change made for this ticket. Cover the happy path, important edge cases and failure modes, using the repository\'s existing test framework and style. Do not change production code. If a new test reveals a bug in the production code, set needs_rework to true and describe the bug in rework_notes so the implementation step can fix it.',
      expectedOutputs: [out('tests_added', 'number', 'Number of tests you added'), out('summary', 'string', 'What the tests cover')],
    },
  }),
  tpl({
    id: 'run-tests', category: 'Quality',
    description: 'Runs the project\'s test suite (`npm test`) and fails the workflow when tests fail.',
    step: { name: 'Run Tests', type: 'SHELL', command: 'if [ -f package.json ]; then npm test --if-present; else echo "No package.json - no tests to run"; fi', jiraComment: true, timeoutSec: 1800, requiresTools: ['node', 'npm'] },
  }),
  tpl({
    id: 'lint', category: 'Quality',
    description: 'Runs the linter (`npm run lint`) when the project defines one.',
    step: { name: 'Lint', type: 'SHELL', command: 'npm run lint --if-present', timeoutSec: 600, requiresTools: ['node', 'npm'] },
  }),
  tpl({
    id: 'build', category: 'Quality',
    description: 'Builds the project (`npm run build`) to make sure the change compiles.',
    step: { name: 'Build', type: 'SHELL', command: 'npm run build --if-present', timeoutSec: 1800, requiresTools: ['node', 'npm'] },
  }),
  tpl({
    id: 'code-review', category: 'Quality',
    description: 'Reviews the diff like a senior engineer and reports problems for the implementation step to fix.',
    step: {
      name: 'Code Review', type: 'AI_PROMPT', jiraComment: true,
      prompt: 'Review the changes made so far (git diff against the default branch) like a senior engineer. Focus on correctness, error handling, clarity, test coverage and risk. Do NOT change code yourself: the implementation step fixes what you find. If you find real problems, set needs_rework to true and list them precisely in rework_notes (file, problem, severity, suggested fix). Do not nitpick style.',
      expectedOutputs: [out('issues_found', 'number', 'Number of problems you found'), out('summary', 'string', 'Short review summary')],
    },
  }),
  tpl({
    id: 'security-review', category: 'Security',
    description: 'Scans the change for OWASP Top 10 issues, leaked secrets and risky dependencies and reports the findings (fixing is left to the implementation step).',
    step: {
      name: 'Security Review', type: 'AI_PROMPT', jiraComment: true,
      prompt: 'Security-review the changes made so far. Check for OWASP Top 10 issues (injection, broken access control, XSS, SSRF, ...), secrets or credentials in code, unsafe deserialization, missing input validation and risky new dependencies. Do NOT fix anything yourself: the implementation step fixes the findings. If you find problems, set needs_rework to true and list every finding precisely in rework_notes (file, problem, severity, how to fix). Never print secret values.',
      expectedOutputs: [out('findings', 'number', 'Total number of findings'), out('critical', 'number', 'Findings with critical or high severity'), out('summary', 'string', 'Short summary of the findings')],
    },
  }),
  tpl({
    id: 'screenshots-before', category: 'Quality',
    description: 'Takes BEFORE screenshots of the pages the ticket affects, ahead of the change (place it before the implementation step).',
    step: {
      name: 'Screenshots (before)', type: 'AI_PROMPT', timeoutSec: 2400,
      requiresTools: ['node', 'playwright'],
      artifacts: ['.nova/screenshots/plan.json', '.nova/screenshots/before/**'],
      prompt: 'Capture BEFORE screenshots of the application, ahead of any change. Do NOT modify any tracked file in the repository.\n'
        + '1. Read the ticket and decide which pages or views the change will visibly affect (at most 6).\n'
        + '2. Find out how to start the app (README, package.json scripts, Dockerfile), start it in the background and wait until it answers (e.g. with curl).\n'
        + '3. Write the plan to .nova/screenshots/plan.json: an array of {"name": "<short-kebab-case-id>", "url": "<url>", "steps": ["<optional manual action, e.g. click the Settings tab>"]}.\n'
        + '4. With Playwright (chromium, viewport 1440x900, full page) save one PNG per plan entry as .nova/screenshots/before/<name>.png. Use the same settings for every shot.\n'
        + '5. Stop the app again.\n'
        + 'If the app cannot be started or has no UI, take no screenshots, report screenshots = 0 and explain why in the summary.',
      expectedOutputs: [out('screenshots', 'number', 'Number of screenshots you saved'), out('summary', 'string', 'Which pages you captured and how the app was started')],
    },
  }),
  tpl({
    id: 'screenshots-after', category: 'Quality',
    description: 'Takes AFTER screenshots of the same pages as the before step, with the change applied (place it after the implementation step).',
    step: {
      name: 'Screenshots (after)', type: 'AI_PROMPT', timeoutSec: 2400,
      requiresTools: ['node', 'playwright'],
      artifacts: ['.nova/screenshots/after/**'],
      prompt: 'Capture AFTER screenshots of the application with the change applied. Do NOT modify any tracked file in the repository.\n'
        + '1. Read .nova/screenshots/plan.json written by the "Screenshots (before)" step. If it is missing, decide on the pages yourself from the ticket and the diff.\n'
        + '2. Start the app again (README, package.json scripts, Dockerfile), in the background, and wait until it answers.\n'
        + '3. With Playwright (chromium, viewport 1440x900, full page, same settings and same manual actions as before) save one PNG per plan entry as .nova/screenshots/after/<name>.png - the SAME <name> as in before/, so the pair can be compared. Pages that are new through this change get a new name (there is no before image for them).\n'
        + '4. Stop the app again.\n'
        + 'If the app cannot be started or has no UI, take no screenshots, report screenshots = 0 and explain why in the summary.',
      expectedOutputs: [out('screenshots', 'number', 'Number of screenshots you saved'), out('summary', 'string', 'What visibly changed compared to the before screenshots')],
    },
  }),
  tpl({
    id: 'update-docs', category: 'Development',
    description: 'Updates README, docs and the changelog to match the change.',
    step: {
      name: 'Update Documentation', type: 'AI_PROMPT',
      prompt: 'Update the documentation affected by the change: README, docs/ and the changelog if one exists. Describe behaviour, configuration and usage that changed. Keep it short and accurate; do not document things that did not change.',
      expectedOutputs: [out('docs_changed', 'number', 'Number of documentation files you changed'), out('summary', 'string', 'What you documented')],
    },
  }),
  tpl({
    id: 'human-approval', category: 'Process',
    description: 'Pauses the workflow until a person approves in the web app (e.g. before delivery).',
    step: { name: 'Human Approval', type: 'HUMAN_APPROVAL', jiraComment: true },
  }),
  tpl({
    id: 'create-pull-request', category: 'Delivery',
    description: 'Commits, pushes the ticket branch and opens a pull request (must be the last step).',
    step: { name: 'Create Pull Request', type: 'PULL_REQUEST' },
  }),
];

/** A step in an organisation's Library (what the API returns and the step marketplace shows). */
export interface LibraryStep {
  id: string;
  name: string;
  description: string;
  category: string;
  type: StepType;
  step: Omit<StepDef, 'id'>;
  /** catalog id for entries seeded from the built-in catalog, else null */
  builtinKey: string | null;
  updatedAt: string;
}

/** Validate/normalise the step of a library entry (a throw-away id is used because library steps get a fresh id on insert). */
export function parseLibraryStep(raw: unknown): Omit<StepDef, 'id'> {
  const { id: _id, ...step } = StepDefSchema.parse({ ...(raw as object), id: 'template' });
  // a library step is standalone: it cannot point at a step of some workflow
  const { dependsOn: _deps, ...rest } = step; // dependencies refer to steps of one workflow
  return { ...rest, sendBack: { ...step.sendBack, goToStepId: null, goToGroupId: null } };
}

export const findStepTemplate = (id: string) => STEP_CATALOG.find((t) => t.id === id);
