#!/usr/bin/env node
// Nova Factory rework reporter. Zero dependencies (Node >= 18). Used by the nova-factory-rework skill.
//   detect                                print {"factory":true|false|null,"pr":url}: is this branch's pull request created by Nova Factory (null = unknown)
//   session [--new]                       print the stable session id of this checkout + branch
//   consent                               print {"asked":bool,"githubUser":string|null}
//   consent --set yes [--user <name>]     allow attaching the GitHub username (found via `gh`/git config when --user is omitted)
//   consent --set no                      do not attach it
//   send < report.json                    submit a report (summaries only) to the Factory
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const HOME = join(process.env.NOVA_FACTORY_HOME || join(homedir(), '.nova-factory'));
const CONSENT = join(HOME, 'consent.json');
const REPORT_KEYS = ['sessionId', 'reportKind', 'runId', 'branch', 'ticketKey', 'prRef', 'corrections'];
const CORRECTION_KEYS = ['correctionId', 'category', 'summary', 'reason', 'workflowGap', 'prevention', 'confidence', 'promptCount', 'durationSec', 'occurredAt'];

const fail = (msg, code = 1) => { console.error(`nova-report: ${msg}`); process.exit(code); };
const run = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const writeJson = (p, v) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`); };
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };

function repoRoot() { return run('git', ['rev-parse', '--show-toplevel']) || process.cwd(); }
function branch() { return run('git', ['rev-parse', '--abbrev-ref', 'HEAD']); }
function config() {
  const c = readJson(join(repoRoot(), '.nova-factory.json'));
  if (!c?.apiUrl || !c?.ingestKey) fail('.nova-factory.json is missing or incomplete (is this repository prepared by Nova Factory?)', 2);
  return c;
}

function session() {
  const key = createHash('sha256').update(`${repoRoot()}\n${branch()}`).digest('hex').slice(0, 16);
  const file = join(HOME, 'sessions', `${key}.json`);
  let s = readJson(file);
  if (!s?.sessionId || process.argv.includes('--new')) { s = { sessionId: randomUUID(), createdAt: new Date().toISOString() }; writeJson(file, s); }
  return s.sessionId;
}

function consent() {
  const set = arg('--set');
  if (set) {
    if (set !== 'yes' && set !== 'no') fail('--set expects yes or no');
    let githubUser = null;
    if (set === 'yes') {
      githubUser = arg('--user') || run('gh', ['api', 'user', '--jq', '.login']) || run('git', ['config', 'github.user']);
      if (!githubUser) fail('could not determine your GitHub username, pass --user <name>');
      if (!/^[A-Za-z0-9-]{1,60}$/.test(githubUser)) fail('invalid GitHub username');
    }
    writeJson(CONSENT, { githubUser });
  }
  const c = readJson(CONSENT);
  return { asked: !!c && 'githubUser' in c, githubUser: c?.githubUser ?? null };
}

/** The report as the Factory accepts it. Anything else (prompts, conversation text, ...) is refused here already, before it leaves the machine. */
function validate(r) {
  if (!r || typeof r !== 'object') fail('report must be a JSON object');
  const extra = Object.keys(r).filter((k) => !REPORT_KEYS.includes(k));
  if (extra.length) fail(`unknown field(s) not sent: ${extra.join(', ')}. Only summaries are reported, never prompts or conversations.`);
  if (!Array.isArray(r.corrections) || !r.corrections.length) fail('corrections must be a non-empty array');
  for (const c of r.corrections) {
    const bad = Object.keys(c).filter((k) => !CORRECTION_KEYS.includes(k));
    if (bad.length) fail(`unknown correction field(s) not sent: ${bad.join(', ')}`);
  }
  return r;
}

async function send() {
  const text = readFileSync(0, 'utf8');
  let r; try { r = JSON.parse(text); } catch { fail('stdin is not valid JSON'); }
  validate(r);
  const cfg = config();
  const c = consent();
  const body = { ...r, sessionId: r.sessionId || session(), branch: r.branch || branch() || undefined, ...(c.githubUser ? { githubUser: c.githubUser } : {}) };
  const res = await fetch(`${cfg.apiUrl.replace(/\/$/, '')}/api/ingest/corrections`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.ingestKey}` }, body: JSON.stringify(body) });
  const out = await res.text();
  if (!res.ok) fail(`the Factory answered ${res.status}: ${out}`, 3);
  console.log(out);
}

/** Factory pull requests end with "Created automatically by Nova Factory". Needs the GitHub CLI; without it the answer is unknown (null). */
function detect() {
  const out = run('gh', ['pr', 'view', '--json', 'body,url']);
  if (!out) return { factory: null, pr: null };
  try { const pr = JSON.parse(out); return { factory: /Created automatically by Nova Factory/i.test(pr.body ?? ''), pr: pr.url ?? null }; } catch { return { factory: null, pr: null }; }
}

const cmd = process.argv[2];
if (cmd === 'session') console.log(session());
else if (cmd === 'detect') console.log(JSON.stringify(detect()));
else if (cmd === 'consent') console.log(JSON.stringify(consent()));
else if (cmd === 'send') await send();
else fail('usage: nova-report.mjs detect | session | consent [--set yes|no [--user name]] | send < report.json');
