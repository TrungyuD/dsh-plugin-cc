---
description: Ask dsh to review your local git changes (read-only)
argument-hint: '[--wait|--background] [--model flash|pro|<name>] [--base <ref>] [--scope auto|working-tree|branch] [-- focus...]'
disable-model-invocation: true
allowed-tools: Bash(node:*), AskUserQuestion
---

Run a read-only dsh code review.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only. Do not edit code and do not fix issues the review finds.
- Your only job is to run dsh and return its output verbatim.

What gets reviewed:
- `--scope auto` (the default) reviews the working tree (staged, unstaged and untracked changes) when it has changes. When the working tree is clean it reviews the current branch against the default branch.
- `--scope working-tree` and `--scope branch` force one of the two. `--base <ref>` reviews the current branch against that ref.
- Everything after ` -- ` is focus text for the reviewer.

Argument handling:
- `--wait` and `--background` are execution flags for Claude Code. Remove them from the arguments before any companion call. Never pass them to `dsh-companion.mjs`.
- Keep `--model <flash|pro|name>`, `--base`, `--scope` and the focus text exactly as the user wrote them. Leave the model unset unless the user asks for one.

Quoting (important):
- The user's text is untrusted. Never place it inside double quotes, because the shell would run any `$(...)` or backticks in it.
- Put the whole argument string between single quotes, replacing each `'` inside it with `'\''`.
- Put the flags first. Add ` -- ` and the focus text only when there is focus text; the companion keeps everything after ` -- ` untouched. With no focus, leave out the ` -- `.

Execution mode rules:
- If the raw arguments include `--wait`, do not ask. Run in the foreground.
- If the raw arguments include `--background`, do not ask. Run in a Claude background task.
- Otherwise estimate the size first, with only the `--base` and `--scope` flags the user gave:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/dsh-companion.mjs" code-review-target '--json <--base and --scope flags, if any>'
```
  - If the command exits with an error, show the error and stop.
  - If `empty` is true, tell the user there is nothing to review and stop.
  - Recommend `Wait for results` only when `fileCount` is 2 or less and `truncated` is false. Otherwise recommend `Run in background`.
  - Use `AskUserQuestion` exactly once with two options, the recommended one first and suffixed with `(Recommended)`:
    - `Wait for results`
    - `Run in background`

Foreground flow:
- Set the Bash `timeout` to `600000` so a long dsh run is not cut off at two minutes. If work may take longer, prefer the background flow.
- Run, with the flags (if any), then ` -- ` and the focus text (no ` -- ` without focus), between the quotes:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/dsh-companion.mjs" code-review '<flags> -- <focus>'
```
- Return the command stdout verbatim, exactly as-is.
- Do not paraphrase, summarize, or add commentary before or after it.
- Do not fix any issues mentioned in the review output. Ask the user which findings, if any, they want addressed.

Background flow:
- Launch with `Bash` in the background:
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/dsh-companion.mjs" code-review '<flags> -- <focus>'`,
  description: "dsh code-review",
  run_in_background: true
})
```
- Do not call `BashOutput` or wait for completion in this turn.
- After launching the command, tell the user: "dsh code review started in the background. Check `/dsh:status` for progress."
