---
description: Delegate investigation, an explicit fix request, or follow-up rescue work to the dsh rescue subagent
argument-hint: "[--background|--wait] [--resume|--fresh] [--write|--read-only] [--model flash|pro|<name>] [what dsh should investigate, solve, or continue]"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `dsh:dsh-rescue` subagent via the `Agent` tool (`subagent_type: "dsh:dsh-rescue"`), forwarding the raw user request as the prompt.
`dsh:dsh-rescue` is a subagent, not a skill. Do not call `Skill(dsh:dsh-rescue)` (no such skill) or `Skill(dsh:rescue)` (that re-enters this command and hangs the session). The command runs inline so the `Agent` tool stays in scope.
The final user-visible response must be dsh's output verbatim.

Raw user request:
$ARGUMENTS

Execution mode:

- If the request includes `--background`, run the `dsh:dsh-rescue` subagent in the background.
- If the request includes `--wait`, run the `dsh:dsh-rescue` subagent in the foreground.
- If neither flag is present, default to foreground.
- `--background` and `--wait` are execution flags for Claude Code. Do not forward them to `task`, and do not treat them as part of the natural-language task text.
- `--model`, `--write` and `--read-only` are runtime-selection flags. Preserve them for the forwarded `task` call, but do not treat them as part of the natural-language task text.
- If the request includes `--resume`, do not ask whether to continue. The user already chose.
- If the request includes `--fresh`, do not ask whether to continue. The user already chose.
- Otherwise, before starting dsh, check for a resumable rescue session from this Claude session by running:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/dsh-companion.mjs" task-resume-candidate --json
```

- If that helper reports `available: true`, use `AskUserQuestion` exactly once to ask whether to continue the current dsh session or start a new one.
- The two choices must be:
  - `Continue current dsh session`
  - `Start a new dsh session`
- If the user is clearly giving a follow-up instruction such as "continue", "keep going", "resume", "apply the top fix", or "dig deeper", put `Continue current dsh session (Recommended)` first.
- Otherwise put `Start a new dsh session (Recommended)` first.
- If the user chooses continue, add `--resume` before routing to the subagent.
- If the user chooses a new session, add `--fresh` before routing to the subagent.
- If the helper reports `available: false`, do not ask. Route normally.

Operating rules:

- The subagent's `Bash` call must set `timeout` to `600000`. Hand the subagent the user's text as-is; it is responsible for single-quoting it.

- The subagent is a thin forwarder only. It uses one `Bash` call to invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/dsh-companion.mjs" task ...` and returns that command's stdout as-is.
- Return the dsh companion stdout verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- Do not ask the subagent to inspect files, monitor progress, poll `/dsh:status`, fetch `/dsh:result`, call `/dsh:cancel`, summarize output, or do follow-up work of its own.
- Leave the model unset unless the user explicitly asks for one. `flash` and `pro` are accepted aliases.
- A resumed session keeps the permission mode it was created with. If the user asks for a different mode on a resumed session, the companion fails with a message to use `--fresh`; relay that message as-is.
- Leave `--resume` and `--fresh` in the forwarded request. The subagent handles that routing when it builds the `task` command.
- If the helper reports that dsh is missing or unauthenticated, stop and tell the user to run `/dsh:setup`.
- If the user did not supply a request, ask what dsh should investigate or fix.
