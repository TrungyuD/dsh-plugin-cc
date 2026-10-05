---
description: Show the stored final output for a finished dsh job in this repository
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/dsh-companion.mjs" result "$ARGUMENTS"`

Present the full command output to the user. Do not summarize or condense it. Preserve all details including:
- Job ID and status
- The complete result, including the verdict, findings, details, and next steps
- File paths and line numbers exactly as reported
- Any error messages
- The `dsh session` footer and follow-up commands such as `/dsh:status <id>`
