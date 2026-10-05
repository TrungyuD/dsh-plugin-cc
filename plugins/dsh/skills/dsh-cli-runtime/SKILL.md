---
name: dsh-cli-runtime
description: Internal helper contract for calling the dsh-companion runtime from Claude Code
user-invocable: false
---

# dsh Runtime

Use this skill only inside the `dsh:dsh-rescue` subagent.

Primary helper:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/dsh-companion.mjs" task "<raw arguments>"`

Execution rules:
- Set the Bash `timeout` to `600000` and put the task text between single quotes (escape each `'` as `'\''`), after all flags.
- The rescue subagent is a forwarder, not an orchestrator. Its only job is to invoke `task` once and return that stdout unchanged.
- Prefer the helper over hand-rolled `dsh` command lines or any other Bash activity.
- Do not call `setup`, `plan`, `review-plan`, `status`, `result`, or `cancel` from `dsh:dsh-rescue`.
- Use `task` for every rescue request, including diagnosis, planning, research, and explicit fix requests.
- Leave the model unset by default. Add `--model` only when the user explicitly asks for one. The aliases are `flash` (deepseek-flash) and `pro` (deepseek-v4-pro).

Flags the `task` helper accepts:
- `--write`: run with the workspace-write sandbox.
- `--read-only`: run with the read-only sandbox. This is the helper's default when neither flag is given, so the agent always states the mode it wants.
- `--resume-last`: continue the previous rescue session of this Claude session in this directory.
- `--model <flash|pro|name>`.

Command selection:
- Use exactly one `task` invocation per rescue handoff.
- Strip `--background` and `--wait` before calling `task`. They are Claude-side execution control only.
- `--resume`: strip that token from the task text and add `--resume-last`.
- `--fresh`: strip that token from the task text and do not add `--resume-last`.
- Fresh run: add `--write` unless the user asked for read-only, diagnosis-only or research-only work, in which case add `--read-only`.
- Resumed run: add no mode flag unless the user explicitly asked for one. The session keeps the mode it was created with, and asking for a different mode fails with an instruction to use `--fresh`.

Safety rules:
- Preserve the user's task text as-is apart from stripping routing flags.
- Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own.
- Return the stdout of the `task` command exactly as-is.
- If the Bash call fails, return its error message and nothing else.
