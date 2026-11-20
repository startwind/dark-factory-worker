import Ajv from 'ajv';
import type { ExpectedOutput } from './workflow.js';

const ajv = new Ajv({ allErrors: true, strict: false });

/** System field every AI step may add. Empty/omitted when nothing noteworthy happened. */
export const OBSERVATIONS_KEY = 'observations';

/**
 * Standard result fields every AI step may set (reserved, cannot be used as custom output keys):
 *   needs_rework: true  - the step CHECKED something (review, scan, QA) and found problems that someone else must fix.
 *                         The step itself succeeds; it only reports. With "send back to" configured the workflow goes back
 *                         to that earlier step (e.g. Implementation), which receives the findings as feedback.
 *   rework_notes:       - the findings: what is wrong and what has to be fixed (this is the feedback text).
 */
export const NEEDS_REWORK_KEY = 'needs_rework';
export const REWORK_NOTES_KEY = 'rework_notes';
export const RESERVED_OUTPUT_KEYS = [NEEDS_REWORK_KEY, REWORK_NOTES_KEY, OBSERVATIONS_KEY] as const;

/** Did the step report that rework is needed? */
export function extractRework(data: Record<string, unknown> | null | undefined): { requested: boolean; notes: string | null } {
  const v = data?.[NEEDS_REWORK_KEY];
  const requested = v === true || (typeof v === 'string' && v.trim().toLowerCase() === 'true');
  const n = data?.[REWORK_NOTES_KEY];
  return { requested, notes: typeof n === 'string' && n.trim() ? n.trim() : null };
}

export function buildJsonSchema(outputs: ExpectedOutput[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const o of outputs) {
    properties[o.key] = { type: o.type, ...(o.instruction ? { description: o.instruction } : {}) };
  }
  properties[NEEDS_REWORK_KEY] = {
    type: 'boolean',
    description: 'OPTIONAL. Set to true ONLY if your task was to check/review/scan something and you FOUND problems that must be fixed by the implementation step. Do not fix them yourself. Omit it when nothing needs rework.',
  };
  properties[REWORK_NOTES_KEY] = {
    type: 'string',
    description: 'REQUIRED when needs_rework is true: the findings, precisely (file, problem, severity, suggested fix). This text is handed to the implementation step.',
  };
  properties[OBSERVATIONS_KEY] = {
    type: 'string',
    description:
      'OPTIONAL. Only set if something exceptional happened. Omit the field entirely otherwise. Never write "nothing special".',
  };
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    properties,
    required: outputs.filter((o) => o.required).map((o) => o.key),
    additionalProperties: true,
  };
}

export interface ValidationResult {
  ok: boolean;
  data?: Record<string, unknown>;
  errors: string[];
}

/** Parse + validate agent output (syntax, required fields, datatypes). */
export function validateOutput(raw: string | unknown, outputs: ExpectedOutput[]): ValidationResult {
  let data: unknown = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch (e) {
      return { ok: false, errors: [`Invalid JSON: ${(e as Error).message}`] };
    }
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, errors: ['Result must be a JSON object'] };
  }
  const validate = ajv.compile(buildJsonSchema(outputs));
  if (!validate(data)) {
    const errors = (validate.errors ?? []).map((e) => {
      if (e.keyword === 'required') return `Missing required field "${(e.params as { missingProperty: string }).missingProperty}"`;
      return `${e.instancePath || '(root)'} ${e.message}`.trim();
    });
    return { ok: false, errors };
  }
  return { ok: true, data: data as Record<string, unknown>, errors: [] };
}

/** Numeric outputs become step metrics. */
export function extractMetrics(data: Record<string, unknown>, outputs: ExpectedOutput[]): Record<string, number> {
  const m: Record<string, number> = {};
  for (const o of outputs) {
    const v = data[o.key];
    if (o.type === 'number' && typeof v === 'number' && Number.isFinite(v)) m[o.key] = v;
  }
  return m;
}

export function extractObservation(data: Record<string, unknown>): string | null {
  const v = data[OBSERVATIONS_KEY];
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length ? t : null;
}

/** Find a JSON result inside free-form agent output (marker block or last JSON object). */
export function extractJsonFromText(text: string): string | null {
  const m = text.match(/NOVA_RESULT_BEGIN\s*([\s\S]*?)\s*NOVA_RESULT_END/);
  if (m) return m[1].trim();
  const fence = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
  if (fence.length) return fence[fence.length - 1][1].trim();
  const end = text.lastIndexOf('}');
  if (end < 0) return null;
  for (let start = text.lastIndexOf('{', end); start >= 0; start = text.lastIndexOf('{', start - 1)) {
    const cand = text.slice(start, end + 1);
    try {
      JSON.parse(cand);
      return cand;
    } catch {
      /* keep scanning outward */
    }
  }
  return null;
}
