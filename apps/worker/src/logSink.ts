import type { LogChunk, LogLevel, LogStream } from '@nova/shared';

/** Log writer attributed to a single step. */
export interface StepSink {
  write(stream: LogStream, data: string, level?: LogLevel): void;
  system(text: string, level?: LogLevel): void;
}

/**
 * Per-job log pipeline: line splitting, redaction, monotonic seq, batching and ack-based delivery.
 * Unacked chunks survive disconnects and are re-sent on reconnect (server de-duplicates on seq).
 */
export class LogSink {
  private seq = 0;
  private queue: LogChunk[] = [];
  private partial: Record<string, string> = {};
  private timer: NodeJS.Timeout | null = null;
  private sending = false;
  constructor(
    private runId: string,
    private redact: (s: string) => string,
    private send: (chunks: LogChunk[]) => Promise<boolean>,
    private currentStep: () => string | null,
  ) {}

  /** `stepId`: attribute to this step (steps can run in parallel); default = the step that is "current" */
  write(stream: LogStream, data: string, level?: LogLevel, stepId?: string | null) {
    const key = `${stepId ?? ''}|${stream}`; // partial lines are kept per step and stream, so parallel steps never mix
    const buf = (this.partial[key] ?? '') + data.replace(/\r\n/g, '\n');
    const lines = buf.split('\n');
    this.partial[key] = lines.pop() ?? '';
    for (const l of lines) this.push(stream, l, level, stepId);
  }
  system(text: string, level: LogLevel = 'info', stepId?: string | null) {
    this.push('system', text, level, stepId);
  }
  /** A writer bound to one step: everything it writes is attributed to that step, however many steps run at the same time. */
  forStep(stepId: string): StepSink {
    return {
      write: (stream, data, level) => this.write(stream, data, level, stepId),
      system: (text, level = 'info') => this.system(text, level, stepId),
    };
  }
  flushPartial() {
    for (const [k, v] of Object.entries(this.partial)) {
      if (!v) continue;
      const [step, stream] = [k.slice(0, k.indexOf('|')), k.slice(k.indexOf('|') + 1)];
      this.push(stream as LogStream, v, undefined, step || undefined);
    }
    this.partial = {};
  }
  private push(stream: LogStream, text: string, level?: LogLevel, stepId?: string | null) {
    if (this.queue.length > 50_000) this.queue.shift(); // bounded memory when offline for a long time
    const lv = level ?? (stream === 'stderr' ? 'warn' : /\b(error|fatal|failed|exception)\b/i.test(text) ? 'error' : 'info');
    this.queue.push({ runId: this.runId, stepRunKey: stepId !== undefined ? stepId : this.currentStep(), seq: ++this.seq, ts: new Date().toISOString(), stream, level: lv, text: this.redact(text) });
    this.schedule();
  }
  private schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, 150);
  }
  async flush(): Promise<void> {
    if (this.sending || !this.queue.length) return;
    this.sending = true;
    try {
      while (this.queue.length) {
        const batch = this.queue.slice(0, 200);
        const ok = await this.send(batch);
        if (!ok) break; // keep for retry
        this.queue.splice(0, batch.length);
      }
    } finally {
      this.sending = false;
    }
    if (this.queue.length) setTimeout(() => void this.flush(), 2000).unref();
  }
  async drain(timeoutMs = 15000) {
    this.flushPartial();
    const end = Date.now() + timeoutMs;
    while (this.queue.length && Date.now() < end) {
      await this.flush();
      if (this.queue.length) await new Promise((r) => setTimeout(r, 300));
    }
  }
  pending() { return this.queue.length; }
}
