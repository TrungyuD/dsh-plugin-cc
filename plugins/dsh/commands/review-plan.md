---
description: Ask dsh to review an implementation plan against the real codebase (read-only)
argument-hint: '[--wait|--background] [--model flash|pro|<name>] [plan-path] [focus...]'
disable-model-invocation: true
allowed-tools: Bash(node:*), AskUserQuestion
---

Run a read-only dsh plan review.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only. Do not edit the plan or the code, and do not fix issues the review finds.
- Your only job is to run dsh and return its output verbatim.

Resolving the plan path:
- The plan path is the first argument that is not a flag or a flag value. It may be a plan file or a plan directory (`plan.md` plus `phase-*.md`). Everything after it is focus text.
- If the first positional argument is not an existing path, treat it as focus text and consider the path missing.
- If a path is given, use it as-is.
- If no path is given, run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/dsh-companion.mjs" plan-candidates --json
```
  - If `latest` is set, use `AskUserQuestion` exactly once (single-select) with the question `Review which plan?` and two options, in this order:
    - `<latest> (Recommended)`
    - `Enter a path`
  - If the user picks `Enter a path`, ask for the path in plain text.
  - If the user types a path in the "Other" field, use it as given.
  - If `latest` is null, skip the picker and ask for the path directly in plain text.

Argument handling:
- `--wait` and `--background` are execution flags for Claude Code. Remove them from the arguments before the companion call. Never pass them to `dsh-companion.mjs`.
- Keep `--model <flash|pro|name>` and the focus text exactly as the user wrote them. Leave the model unset unless the user asks for one.

Quoting (important):
- The user's text is untrusted. Never place it inside double quotes, because the shell would run any `$(...)` or backticks in it.
- Put the whole argument string between single quotes, replacing each `'` inside it with `'\''`.
- Flags such as `--model` go before the request text. Everything after the first plain word is treated as text by the companion.

Execution mode rules:
- If the raw arguments include `--wait`, do not ask. Run in the foreground.
- If the raw arguments include `--background`, do not ask. Run in a Claude background task.
- Otherwise use `AskUserQuestion` exactly once with two options, the recommended one first:
  - `Run in background (Recommended)`
  - `Wait for results`
- This makes at most two pickers in total (plan, then wait or background). Never ask a third question.

Foreground flow:
- Set the Bash `timeout` to `600000` so a long dsh run is not cut off at two minutes. If work may take longer, prefer the background flow.
- Run, with the resolved path, then the focus text, between the quotes:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/dsh-companion.mjs" review-plan '<remaining arguments> <plan-path> <focus>'
```
- Return the command stdout verbatim, exactly as-is.
- Do not paraphrase, summarize, or add commentary before or after it.
- Do not fix any issues mentioned in the review output. Ask the user which findings, if any, they want addressed.

Background flow:
- Launch with `Bash` in the background:
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/dsh-companion.mjs" review-plan '<remaining arguments> <plan-path> <focus>'`,
  description: "dsh review-plan",
  run_in_background: true
})
```
- Do not call `BashOutput` or wait for completion in this turn.
- After launching the command, tell the user: "dsh plan review started in the background. Check `/dsh:status` for progress."
