import type { ResolvedWorkflow } from './workflow.js';

export type AgentKind = 'codex' | 'claude' | 'mock' | 'custom';

export interface WorkerAgentInfo {
  key: string; // e.g. "codex"
  kind: AgentKind;
  available: boolean;
  version?: string | null;
  path?: string | null;
  source: 'auto' | 'manual';
  runtime: 'container' | 'host';
  lastTest?: { ok: boolean; at: string; message?: string } | null;
}

/** Result of the worker's start-up tool check. `required` failures block real jobs; `recommended` ones are needed for real GitHub. */
export interface WorkerToolCheck {
  id: string;
  label: string;
  ok: boolean;
  severity: 'required' | 'recommended';
  version?: string | null;
  message: string;
  /** how to fix it (shown in the web app) */
  hint?: string;
}
export interface WorkerHealth {
  checkedAt: string;
  checks: WorkerToolCheck[];
}

export interface WorkerHello {
  fingerprint: string;
  publicKey: string;
  name: string;
  hostname: string;
  platform: string;
  maxConcurrentJobs: number;
  agents: WorkerAgentInfo[];
  activeJobs: string[]; // runIds the worker is still executing (reconnect)
  version: string;
  health?: WorkerHealth;
}

export interface SkillPayload {
  id: string;
  name: string;
  source: 'repository' | 'marketplace';
  path?: string;
  version?: string;
  content: string; // SKILL.md content (untrusted)
}

export interface JobPayload {
  runId: string;
  assignmentId: string;
  isTest: boolean;
  project: { id: string; name: string; defaultAgentKey: string };
  ticket: { key: string; title: string; description: string; type: string; components: string[]; priority: string; url?: string | null };
  repo: {
    cloneUrl: string;
    defaultBranch: string;
    /** branch the ticket branch is cut from (predecessor ticket); missing = defaultBranch */
    baseBranch?: string;
    branch: string;
    /** transient credential for clone/push; never persisted by the worker */
    authToken?: string | null;
    authUser?: string | null;
    mock: boolean;
    /** null = the repo has no Dockerfile: the job runs directly on the worker host (no container) */
    dockerfilePath: string | null;
  };
  workflow: ResolvedWorkflow;
  skills: SkillPayload[];
  limits: { memory: string; cpus: string; pids: number; stepTimeoutSec: number };
  retry: { technicalRetries: number; jsonCorrectionAttempts: number };
  factoryRunUrl: string;
}

export type LogStream = 'stdout' | 'stderr' | 'system';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogChunk {
  runId: string;
  stepRunKey?: string | null; // step id
  seq: number; // monotonic per run, assigned by the worker -> idempotent
  ts: string;
  stream: LogStream;
  level: LogLevel;
  text: string;
}

export interface StepResultPayload {
  runId: string;
  stepId: string;
  attempt: number;
  status: 'COMPLETED' | 'FAILED' | 'STOPPED';
  startedAt: string;
  endedAt: string;
  agentKey: string | null;
  output: Record<string, unknown> | null;
  metrics: Record<string, number>;
  observation: string | null;
  error?: { kind: ErrorKind; message: string } | null;
  exitCode?: number | null;
}

export type ErrorKind =
  | 'AGENT_UNAVAILABLE'
  | 'AGENT_AUTH'
  | 'AGENT_TIMEOUT'
  | 'CONTAINER_BUILD'
  | 'GIT_CONFLICT'
  | 'GITHUB_UNREACHABLE'
  | 'JIRA_UNREACHABLE'
  | 'INVALID_JSON'
  | 'WORKER_OFFLINE'
  | 'WORKER_CRASHED'
  | 'COMMAND_FAILED'
  | 'REWORK_EXHAUSTED'
  | 'TIMEOUT'
  | 'STOPPED'
  | 'INTERNAL';

export interface ValidationJobPayload {
  requestId: string;
  repo: JobPayload['repo'];
  dockerfilePath: string;
}
export interface ValidationResultPayload {
  ok: boolean;
  dockerfileFound: boolean;
  buildOk: boolean;
  message: string;
  log: string;
}

export type Ack<T = unknown> = (res: { ok: true; data?: T } | { ok: false; error: string }) => void;

/** worker -> server */
export interface WorkerToServer {
  'worker:heartbeat': (p: { activeJobs: string[]; freeSlots: number }, ack?: Ack) => void;
  'worker:capabilities': (p: { agents: WorkerAgentInfo[]; maxConcurrentJobs: number }, ack?: Ack) => void;
  'worker:status': (p: { freeSlots: number; activeJobs: string[] }) => void;
  'job:accepted': (p: { runId: string; assignmentId: string }, ack?: Ack) => void;
  'job:rejected': (p: { runId: string; assignmentId: string; reason: string }, ack?: Ack) => void;
  'job:started': (p: { runId: string; assignmentId: string; containerId?: string | null }, ack?: Ack) => void;
  /** setup stage of a job before/between steps (cloning, building image, starting container …) */
  'job:phase': (p: { runId: string; phase: string; detail?: string; /** live detail update of the current phase (not stored as an event) */ progress?: boolean }) => void;
  'job:progress': (p: { runId: string; stepId: string; phase: string }) => void;
  'job:completed': (p: { runId: string; assignmentId: string; branch: string; summary: string }, ack?: Ack) => void;
  'job:failed': (p: { runId: string; assignmentId: string; stepId?: string | null; kind: ErrorKind; message: string }, ack?: Ack) => void;
  'job:stopped': (p: { runId: string; assignmentId: string; note?: string }, ack?: Ack) => void;
  'job:stop-confirmed': (p: { runId: string; assignmentId: string; note?: string }, ack?: Ack) => void;
  'step:started': (p: { runId: string; stepId: string; attempt: number; agentKey: string | null; startedAt: string }, ack?: Ack) => void;
  'step:output': (p: StepResultPayload, ack?: Ack) => void;
  'step:completed': (p: StepResultPayload, ack?: Ack) => void;
  'step:failed': (p: StepResultPayload, ack?: Ack) => void;
  'step:awaiting-approval': (p: { runId: string; stepId: string }, ack?: Ack) => void;
  'log:chunk': (p: { runId: string; chunks: LogChunk[] }, ack?: Ack<{ lastSeq: number }>) => void;
  'pr:create': (
    p: { runId: string; branch: string; summary: string },
    ack: Ack<{ url: string; number: number }>,
  ) => void;
  'validation:result': (p: { requestId: string; result: ValidationResultPayload }, ack?: Ack) => void;
}

/** server -> worker */
export interface ServerToWorker {
  'worker:approved': (p: { workerId: string }) => void;
  'job:assigned': (p: JobPayload, ack?: Ack) => void;
  'job:stop-requested': (p: { runId: string; reason: string; requestedBy: string }) => void;
  'approval:resolved': (p: { runId: string; stepId: string; approved: boolean; by: string }) => void;
  'validation:request': (p: ValidationJobPayload) => void;
  'server:error': (p: { message: string }) => void;
}

export interface UiRunUpdate {
  runId: string;
  kind: 'run' | 'step' | 'metric' | 'event' | 'pr';
}

/** server -> browser */
export interface ServerToUi {
  'run:updated': (p: UiRunUpdate) => void;
  'run:log': (p: { runId: string; chunks: LogChunk[] }) => void;
  'worker:updated': (p: { workerId: string }) => void;
  'dashboard:updated': (p: Record<string, never>) => void;
}
export interface UiToServer {
  'run:subscribe': (p: { runId: string; fromSeq?: number }, ack: Ack<{ canViewLogs: boolean; chunks: LogChunk[] }>) => void;
  'run:unsubscribe': (p: { runId: string }) => void;
}

/** Socket.IO worker handshake */
export interface WorkerChallenge {
  challenge: string;
}
export interface WorkerAuthPayload {
  hello: WorkerHello;
  signature: string; // signChallenge(identity, challenge)
}
