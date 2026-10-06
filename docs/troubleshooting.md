# Troubleshooting

Start with `/dsh:setup`. It checks Node.js, npm and dsh, checks that the dsh
version is supported, and runs a one-line read-only prompt to confirm you are
logged in. It prints the next step for anything that is missing.

## dsh is not installed

Commands fail with `dsh is not installed. Run /dsh:setup.`

Run `/dsh:setup`. When npm is available it offers to run
`npm install -g @deepseek-ai/dsh`. You can also run that yourself. Make sure the
global npm `bin` directory is on the `PATH` that Claude Code sees, then restart
Claude Code.

## The dsh version is not supported

`/dsh:setup` warns when dsh is outside `>=0.2.0-rc.2 <0.3.0`. Install a supported
version:

```
npm install -g @deepseek-ai/dsh@0.2
```

dsh is still a release candidate, and flags or event names can change between
versions. [dsh-compat.md](dsh-compat.md) lists everything the plugin relies on.

## Not logged in

The smoke prompt in `/dsh:setup` fails, or every run ends with a provider or
authentication error.

Run `! dsh-tui` in Claude Code, sign in with `/login`, exit, then run
`/dsh:setup` again.

## A foreground run stops early

Foreground runs are limited by Claude Code's Bash timeout, which the commands
set to 10 minutes. Run longer work with `--background`, then follow it with
`/dsh:status` and read it with `/dsh:result`.

## A job looks stuck

1. Run `/dsh:status <job-id>` to see its phase, elapsed time, recent progress
   and log path.
2. Run `/dsh:cancel <job-id>` to stop it. This stops the dsh process group and
   marks the job cancelled.

`Multiple dsh jobs are active. Pass a job id to /dsh:cancel.` means you need to
pick one. Get the ids from `/dsh:status`.

## Jobs from an old session are still running

Ending a Claude session cancels the jobs that session started from its starting
directory. Jobs started with `--cwd` somewhere else are not cleaned up. Cancel
them with `/dsh:cancel <job-id>` from that directory.

## A resumed rescue is refused

`This dsh session runs in <mode>; start a new one with --fresh to change permissions.`

A resumed session keeps the permission mode it was created with. To change
between `--write` and `--read-only`, start a new session with `--fresh`.

## dsh asked for approval and the run failed

Headless dsh cannot ask you anything, so every approval request fails. This is
intended. Read-only runs cannot be escalated. For changes, use `/dsh:rescue`
without `--read-only`, which runs in `workspace-write`. Work outside the
workspace sandbox is not supported.

## Review-plan cannot find the plan

- `Plan path not found: <path>`: check the path, relative to the repository root.
- `No plan.md in <dir>`: a directory must contain `plan.md`. Its `phase-*.md`
  files are reviewed with it. Otherwise pass a single plan file.

## Timed out waiting for the dsh state lock

Another companion process held the job state lock for more than 8 seconds.
Retry the command. A lock older than 10 seconds is treated as stale and removed
automatically.

## Continue a session in the terminal

Every result footer names its dsh session. Open it in the dsh TUI with:

```
dsh tui --resume <session-id>
```

If you change the session's permission mode there, the plugin's footer and its
`--read-only` check no longer reflect it.

## Collecting information for a bug report

See [SUPPORT.md](../SUPPORT.md#what-to-include).
