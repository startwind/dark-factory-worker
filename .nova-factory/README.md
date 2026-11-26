# Nova Factory: local rework reporting

Pull requests whose description ends with "Created automatically by Nova Factory" were created by the Factory. When you continue work on such a branch with Claude Code or Codex,
the `nova-factory-rework` skill reports **summaries** of the corrections you make, so the Factory can improve its workflows.

- Never sent: prompts, conversations, code, secrets. Only short summaries per correction (category, what, why).
- `.nova-factory.json` holds the Factory URL and a **project-scoped, write-only ingestion key**. It is not a secret and not proof of identity.
- You are asked once whether your GitHub username may be attached. The answer is stored in `~/.nova-factory/consent.json` and can be changed any time:
  `node .claude/skills/nova-factory-rework/scripts/nova-report.mjs consent --set no`
- These files are maintained by Nova Factory (installed through a pull request you accepted). Remove them to stop reporting.
