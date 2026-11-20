import type { AgentEntry } from '../config.js';

/**
 * Agent adapters only describe HOW a CLI is invoked. Discovery (discover.ts), testing (test.ts),
 * execution (jobRunner.ts) and result handling (prompt.ts / validation) are separate modules.
 */
export interface Invocation {
  cmd: string;
  args: string[];
  /** prompt delivered via stdin (avoids argv length limits and process-list leaks) */
  stdin?: string;
}
export interface InvocationCtx {
  prompt: string;
  runtime: 'container' | 'host';
  /** absolute workspace path (host runtime only) */
  workspace?: string;
  /** the mock agent needs the JSON to emit */
  mockResultJson?: string;
  resultPath: string; // path INSIDE the runtime's view of the workspace
}
export interface AgentAdapter {
  kind: string;
  /** names of binaries to look for during discovery */
  binaries: string[];
  versionArgs: string[];
  /** default in-container install command (requires node/npm in the project image) */
  defaultInstall?: string;
  /** env var names commonly needed for auth inside a container */
  defaultEnv: string[];
  testPrompt: string;
  build(entry: AgentEntry, ctx: InvocationCtx): Invocation;
  /** minimal invocation used by `nova-worker test` (host) */
  buildTest(entry: AgentEntry): Invocation;
}

const CLAUDE_TOOLS = 'Bash,Edit,Write,Read,Glob,Grep';

export const codexAdapter: AgentAdapter = {
  kind: 'codex',
  binaries: ['codex'],
  versionArgs: ['--version'],
  defaultInstall: 'npm install -g @openai/codex',
  defaultEnv: ['OPENAI_API_KEY'],
  testPrompt: 'Reply with exactly the single word READY and nothing else.',
  build(e, c) {
    const base = ['exec', '--skip-git-repo-check'];
    // In the container the container IS the sandbox; on the host keep codex's own sandbox on.
    const mode = c.runtime === 'container' ? ['--dangerously-bypass-approvals-and-sandbox'] : ['--sandbox', 'workspace-write', ...(c.workspace ? ['-C', c.workspace] : [])];
    return { cmd: e.command, args: [...base, ...mode, '-'], stdin: c.prompt };
  },
  buildTest(e) {
    return { cmd: e.command, args: ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '-'], stdin: this.testPrompt };
  },
};

export const claudeAdapter: AgentAdapter = {
  kind: 'claude',
  binaries: ['claude'],
  versionArgs: ['--version'],
  defaultInstall: 'npm install -g @anthropic-ai/claude-code',
  defaultEnv: ['ANTHROPIC_API_KEY'],
  testPrompt: 'Reply with exactly the single word READY and nothing else.',
  build(e, c) {
    return { cmd: e.command, args: ['-p', '--permission-mode', 'acceptEdits', '--allowedTools', CLAUDE_TOOLS, '--output-format', 'text'], stdin: c.prompt };
  },
  buildTest(e) {
    return { cmd: e.command, args: ['-p', '--output-format', 'text'], stdin: this.testPrompt };
  },
};

/** MOCK agent: deterministic, no AI. Clearly labeled in logs. Used for credential-free end-to-end tests. */
export const mockAdapter: AgentAdapter = {
  kind: 'mock',
  binaries: [],
  versionArgs: [],
  defaultEnv: [],
  testPrompt: 'READY',
  build(_e, c) {
    const b64 = Buffer.from(c.mockResultJson ?? '{}').toString('base64');
    const script = [
      'echo "[MOCK AGENT] This is a simulated agent. No AI is involved."',
      'echo "[MOCK AGENT] Reading repository..."; ls -1 | head -5; sleep 1',
      'echo "[MOCK AGENT] Analyzing requirements..."; sleep 1',
      'mkdir -p "$(dirname ' + shq(c.resultPath) + ')"',
      'echo "mock change $(date -u +%FT%TZ)" >> NOVA_MOCK.md',
      'echo "[MOCK AGENT] Updating NOVA_MOCK.md"; sleep 1',
      'echo ' + shq(b64) + ' | base64 -d > ' + shq(c.resultPath),
      'echo "[MOCK AGENT] Preparing result JSON..."',
    ].join('; ');
    return { cmd: 'sh', args: ['-c', script] };
  },
  buildTest() {
    return { cmd: 'sh', args: ['-c', 'echo READY'] };
  },
};

export const customAdapter: AgentAdapter = {
  kind: 'custom',
  binaries: [],
  versionArgs: ['--version'],
  defaultEnv: [],
  testPrompt: 'Reply with exactly the single word READY and nothing else.',
  build(e, c) {
    const args = (e.args ?? ['{prompt}']).map((a) => a.replace('{prompt}', c.prompt));
    return { cmd: e.command, args, stdin: e.stdin ? c.prompt : undefined };
  },
  buildTest(e) {
    const p = this.testPrompt;
    return { cmd: e.command, args: (e.args ?? ['{prompt}']).map((a) => a.replace('{prompt}', p)), stdin: e.stdin ? p : undefined };
  },
};

export const ADAPTERS: Record<string, AgentAdapter> = { codex: codexAdapter, claude: claudeAdapter, mock: mockAdapter, custom: customAdapter };

export function adapterFor(key: string, e: AgentEntry): AgentAdapter {
  return ADAPTERS[e.kind ?? key] ?? customAdapter;
}

export function shq(s: string) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
