---
description: Check whether the local dsh CLI is installed, supported and logged in
argument-hint: ''
allowed-tools: Bash(node:*), Bash(npm:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/dsh-companion.mjs" setup --json
```

If the result says dsh is unavailable and npm is available:
- Use `AskUserQuestion` exactly once to ask whether Claude should install dsh now.
- Put the install option first and suffix it with `(Recommended)`.
- Use these two options:
  - `Install dsh (Recommended)`
  - `Skip for now`
- If the user chooses install, run:

```bash
npm install -g @deepseek-ai/dsh
```

- Then rerun:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/dsh-companion.mjs" setup --json
```

If dsh is already installed or npm is unavailable:
- Do not ask about installation.

Output rules:
- Present the final setup output to the user.
- If installation was skipped, present the original setup output.
- If dsh is installed but not logged in, tell the user to run `! dsh-tui` and sign in with `/login`.
