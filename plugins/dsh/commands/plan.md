---
description: Ask dsh to explore the codebase and write an implementation plan (read-only)
argument-hint: '[--wait|--background] [--model flash|pro|<name>] <what to plan>'
disable-model-invocation: true
allowed-tools: Bash(node:*), AskUserQuestion
---

Run a read-only dsh planning pass.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command only produces a plan. Do not implement the plan, edit files, or suggest that you are about to.
- Your only job is to run dsh and return its output verbatim.

Argument handling:
- If no request text is given (ignoring `--wait`, `--background` and `--model <value>`), ask the user what to plan, then continue.
- `--wait` and `--background` are execution flags for Claude Code. Remove them from the arguments before the companion call. Never pass them to `dsh-companion.mjs`.
- Keep `--model <flash|pro|name>` and the request text exactly as the user wrote them. Leave the model unset unless the user asks for one.

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

Foreground flow:
- Set the Bash `timeout` to `600000` so a long dsh run is not cut off at two minutes. If work may take longer, prefer the background flow.
- Run, with the remaining arguments between the quotes:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/dsh-companion.mjs" plan '<remaining arguments>'
```
- Return the command stdout verbatim, exactly as-is.
- Do not paraphrase, summarize, or add commentary before or after it.
- Do not implement anything the plan describes.

Background flow:
- Launch with `Bash` in the background:
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/dsh-companion.mjs" plan '<remaining arguments>'`,
  description: "dsh plan",
  run_in_background: true
})
```
- Do not call `BashOutput` or wait for completion in this turn.
- After launching the command, tell the user: "dsh plan started in the background. Check `/dsh:status` for progress."
