---
description: Cancel an active background dsh job in this repository
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/dsh-companion.mjs" cancel "$ARGUMENTS"`
