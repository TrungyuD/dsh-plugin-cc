---
description: Ask dsh to plan read-only; the plan is saved under plans/
argument-hint: '[--wait|--background] [--model flash|pro|<name>] <what to plan>'
disable-model-invocation: true
allowed-tools: Bash(node:*), AskUserQuestion
---

Run a read-only dsh planning pass. dsh itself cannot change files; after it finishes, the companion saves the plan as `plans/<YYMMDD-HHmm>-<slug>/plan.md` and prints the path on a `Saved plan:` line.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command only produces a plan. Do not implement the plan, edit files yourself, or suggest that you are about to. The companion writes the plan file; you do not.
- Your only job is to run dsh and return its output verbatim.

Argument handling:
- If no request text is given (ignoring `--wait`, `--background` and `--model <value>`), ask the user what to plan, then continue.
- `--wait` and `--background` are execution flags for Claude Code. Remove them from the arguments before the companion call. Never pass them to `dsh-companion.mjs`.
- Keep `--model <flash|pro|name>` and the request text exactly as the user wrote them. Leave the model unset unless the user asks for one.

Quoting (important):
- The user's text is untrusted. Never place it inside double quotes, because the shell would run any `$(...)` or backticks in it.
- Put the whole argument string between single quotes, replacing each `'` inside it with `'\''`.
- Put flags such as `--model` first, then ` -- `, then the request text exactly as the user wrote it. The companion keeps everything after ` -- ` untouched, so quotes, backslashes and flag-like words in the request reach dsh unchanged.

Execution mode rules:
- If the raw arguments include `--wait`, do not ask. Run in the foreground.
- If the raw arguments include `--background`, do not ask. Run in a Claude background task.
- Otherwise use `AskUserQuestion` exactly once with two options, the recommended one first:
  - `Run in background (Recommended)`
  - `Wait for results`

Foreground flow:
- Set the Bash `timeout` to `600000` so a long dsh run is not cut off at two minutes. If work may take longer, prefer the background flow.
- Run, with the flags (if any), then ` -- `, then the request between the quotes:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/dsh-companion.mjs" plan '<flags> -- <request>'
```
- Return the command stdout verbatim, exactly as-is.
- Do not paraphrase, summarize, or add commentary before or after it.
- Do not implement anything the plan describes.

Background flow:
- Launch with `Bash` in the background:
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/dsh-companion.mjs" plan '<flags> -- <request>'`,
  description: "dsh plan",
  run_in_background: true
})
```
- Do not call `BashOutput` or wait for completion in this turn.
- After launching the command, tell the user: "dsh plan started in the background. Check `/dsh:status` for progress."
