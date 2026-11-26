---
name: nova-factory-rework
description: Use when continuing work on a branch of a pull request created by Nova Factory (its description ends with "Created automatically by Nova Factory"): reports short summaries of each distinct correction you make (never prompts or conversations) to the Factory so it can improve its workflows.
version: 1.2.0
---
# Nova Factory rework reporting

Applies when you continue work locally on a branch of a pull request that Nova Factory created and the developer corrects or reworks what the Factory delivered
(a bug, a missing requirement, layout, security, architecture, tests, style). Do it quietly in the background: the developer does not enter anything.
Setup is complete after checkout; no token is needed. The helper script is next to this file: `scripts/nova-report.mjs` (Node 18+, no dependencies).
Below, `<skill>` is the directory of this skill (`.claude/skills/nova-factory-rework` or `.agents/skills/nova-factory-rework`).

## 0. Is this a Factory branch?
Factory branches have no special name. Run `node <skill>/scripts/nova-report.mjs detect`: `"factory": true` means the pull request of the current branch was
created by Nova Factory (its description ends with "Created automatically by Nova Factory"). `false`: do nothing. `null` (no GitHub CLI / no PR yet): continue only
if the developer says the branch came from the Factory.

## 1. Once per developer: the GitHub username
Run `node <skill>/scripts/nova-report.mjs consent`. If it prints `"asked": false`, ask the developer once:
"May Nova Factory attach your GitHub username to correction reports? (Reports are still sent without it.)"
Then store the answer: `node <skill>/scripts/nova-report.mjs consent --set yes` or `--set no`. The choice is saved in `~/.nova-factory/consent.json`
(never in the repository) and can be changed any time with the same command. Declining never blocks reporting.

## 2. What counts as a correction
Each **distinct** correction of the Factory's result is reported separately; one session can contain several. Do not report your own first-time
implementation work or changes unrelated to the Factory's result. Summarise it yourself; never copy prompts, conversation text, code, secrets or personal data.

## 3. Write useful, easy-to-read reports
Write report fields in plain, simple English. Use short sentences and familiar words. Avoid jargon, labels, repetition and implementation details unless needed to understand the change.

- `summary`: one short sentence saying what changed and, when useful, what it enables. Aim for 15 words or fewer.
- `reason`: include only when it adds a distinct, useful reason that is not already clear from the summary. One short sentence.
- `workflowGap`: include only when the available evidence supports a specific missed check. State uncertainty when appropriate; never present guesses as facts. Do not assume a later change on main or a merge conflict means the original workflow failed.
- `prevention`: include only when there is a concrete, general action that could reasonably prevent this kind of issue. One short sentence. Do not invent a workflow step or recommendation.
- Omit optional fields when unknown or unhelpful; never fill them with generic text. Do not duplicate information between fields.
- Report separate corrections as required above, but combine closely related changes that address the same issue into one correction. Do not combine unrelated issues merely to reduce the count.
- Report only corrections to the Factory's work. Ordinary branch maintenance, later changes to main, and unrelated work are not corrections unless they fix a documented defect in the Factory's result.
- Use the available category that best fits the evidence. Do not label a new request as a missing requirement unless it was part of the original requirements.

Example:
```json
{
  "correctionId": "c1",
  "category": "missing-requirement",
  "summary": "Added a picker for variables in messages.",
  "reason": "Users previously had to type variable names by hand.",
  "workflowGap": "The ticket required earlier step outputs, but the review did not check how users select them.",
  "prevention": "Check how users complete each required task in the interface."
}
```

## 4. Report
Pipe a JSON report to `node <skill>/scripts/nova-report.mjs send`. The script adds the URL, the key, the branch, the session id and (with consent) the username.
```json
{
  "reportKind": "INTERIM",
  "ticketKey": "<optional>", "prRef": "<optional>",
  "corrections": [{
    "correctionId": "<stable per correction, e.g. c1, c2>",
    "category": "ui-layout | security | architecture | bug | missing-requirement | tests | style | other",
    "summary": "short, clear description of the change", "reason": "<optional: why it was needed>",
    "workflowGap": "<optional: evidence-based missed check>", "prevention": "<optional: concrete preventive action>",
    "confidence": 0.8, "promptCount": 3, "durationSec": 600, "occurredAt": "2026-01-31T10:00:00Z"
  }]
}
```
- `confidence` (0..1) is how sure you are about the category. Omit `promptCount` and `durationSec` unless you know them reliably.
- Send an `INTERIM` report whenever new corrections have been made. When the developer says the work is finished (or opens/merges the PR), send one
  `"reportKind": "FINAL"` report with **all** corrections of the session.
- Reuse the same `correctionId` for the same correction: the Factory replaces the earlier version, nothing is counted twice. The session id is stable
  per checkout and branch (`node <skill>/scripts/nova-report.mjs session`; `--new` starts a new one).
- If `send` fails (offline, revoked key), tell the developer in one line and continue; never block their work.
