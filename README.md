# dsh-plugin-cc

[![npm](https://img.shields.io/npm/v/dsh-plugin-cc)](https://www.npmjs.com/package/dsh-plugin-cc)

Use [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) from inside Claude Code to plan work, review plans and code changes, and hand tasks to dsh.

This plugin is for Claude Code users who want an easy way to start using dsh from the workflow they already have.

## What You Get

- `/dsh:plan` for a read-only implementation plan written by dsh
- `/dsh:review-plan` to check a plan against the real code
- `/dsh:code-review` to review your local git changes
- `/dsh:rescue`, `/dsh:status`, `/dsh:result` and `/dsh:cancel` to delegate work and manage background jobs

## Requirements

- Node.js 18.18 or later.
- dsh 0.2.x (`>=0.2.0-rc.2 <0.3.0`). Install it with `npm install -g @deepseek-ai/dsh`.
- A logged-in DeepSeek provider. Run `! dsh-tui` in Claude Code and sign in with `/login`.

## Install

```
/plugin marketplace add TrungyuD/dsh-plugin-cc
/plugin install dsh@dsh-plugin-cc
/reload-plugins
/dsh:setup
```

The package is also published on npm as [`dsh-plugin-cc`](https://www.npmjs.com/package/dsh-plugin-cc) (`npm i dsh-plugin-cc`, `yarn add dsh-plugin-cc` or `pnpm add dsh-plugin-cc`). That only downloads the files into `node_modules`; it does not register the plugin with Claude Code. Install it with the `/plugin` commands above.

`/dsh:setup` checks Node, dsh and its version, and runs a one-line read-only smoke prompt to confirm you are logged in. If dsh is missing it offers to install it.

## Commands

| Command | What it does |
|---|---|
| `/dsh:plan <what to plan>` | dsh explores the repository and writes an implementation plan, which is saved as `plans/<YYMMDD-HHmm>-<slug>/plan.md`. dsh itself is read-only. |
| `/dsh:review-plan [path] [focus]` | dsh checks a plan against the real code and answers with `Verdict: approve`, `needs-changes` or `reject`, then findings. Read-only. |
| `/dsh:code-review [--base <ref>] [--scope auto\|working-tree\|branch] [-- focus]` | dsh reviews your local git changes and answers with `Verdict: approve`, `needs-changes` or `reject`, then findings with `path:line`. Read-only, and nothing is saved. |
| `/dsh:rescue [--write\|--read-only] [--resume\|--fresh] <task>` | Hands a debugging or implementation task to dsh through the `dsh-rescue` subagent. |
| `/dsh:status [job-id]` | Lists active and recent jobs for this repository. |
| `/dsh:result [job-id]` | Shows the stored final output of a finished job. |
| `/dsh:cancel [job-id]` | Cancels a running job and its dsh processes. |
| `/dsh:setup` | Checks the installation and login. |

`/dsh:plan`, `/dsh:review-plan` and `/dsh:code-review` take `--wait` or `--background`. Without either, Claude asks once and recommends background (`/dsh:code-review` recommends waiting when the change is small). `/dsh:rescue` takes the same flags. All of them take `--model flash|pro|<name>`.

### Plan

```
/dsh:plan add a --version flag to the CLI
/dsh:plan --model pro --wait split the session code into its own module
```

dsh stays read-only while it explores. When it finishes, the plugin saves the plan as `plans/<YYMMDD-HHmm>-<slug>/plan.md` in the repository and prints `Saved plan: <path>`. A run that fails or is cancelled saves nothing. `/dsh:review-plan` with no path then offers that plan first. If you track `plans/` in git, each run leaves a new untracked file.

### Review a plan

```
/dsh:review-plan                                  # asks which plan; the newest one under ./plans is first
/dsh:review-plan plans/my-plan/phase-02-api.md focus on error handling --wait
/dsh:review-plan plans/my-plan                    # a directory reviews plan.md plus every phase-*.md
```

With no path, Claude shows a picker. The first option is the newest plan under `./plans/` (Recommended). The second is "Enter a path". If there are no plans, Claude asks for the path directly.

### Code review

```
/dsh:code-review                                  # reviews your uncommitted changes, or the branch when the tree is clean
/dsh:code-review --base main -- focus on error handling
/dsh:code-review --scope working-tree --wait
```

`--scope auto` (the default) reviews the working tree when it has changes: staged, unstaged and untracked files. When the working tree is clean, it reviews the current branch against the default branch (`origin/HEAD`, else `main`, `master` or `trunk`). `--scope working-tree` and `--scope branch` force one of the two, and `--base <ref>` reviews the current branch against that ref. A branch review does not include uncommitted edits. Everything after ` -- ` is focus text for the reviewer.

The plugin collects the diff with git and sends it to dsh. If the change is larger than 256 KB, dsh gets the diffstat and the list of changed files and reads the files itself. Untracked files over 24 KB, binary files and symlinks are listed but not included. While it reads your repository, the plugin turns off external diff tools, textconv drivers, fsmonitor and signature checks. Clean filters from the repository config still run, as they do for any `git diff`. With nothing to review, the command prints `Nothing to review` and does not start dsh.

### Rescue

```
/dsh:rescue --write fix the failing parser test
/dsh:rescue --read-only why does the build hang?
/dsh:rescue --resume now add a regression test
```

## Models

The default is `deepseek-flash`, dsh's own default, so nothing is overridden unless you ask. `--model flash` means `deepseek-flash` and `--model pro` means `deepseek-v4-pro`. Any other value is passed through to dsh.

## Permission model

- `/dsh:plan`, `/dsh:review-plan` and `/dsh:code-review` always run read-only for dsh. The sandbox denies file writes, and escalation requests fail because headless dsh has no approval channel. `/dsh:plan` writes one file, the plan, after dsh has finished. `/dsh:code-review` writes nothing.
- `/dsh:rescue` can write by default. Ask for diagnosis or research only, or pass `--read-only`, to prevent edits.
- A resumed rescue session keeps the mode it was created with. Asking for a different mode on resume fails with a message to start a new session with `--fresh`.
- "Read-only" protects your workspace. dsh still writes its own sessions and profile under `~/.dsh/`.
- The plugin never uses dsh's `never` approval policy, because that auto-approves.

## Sessions and jobs

Every run is a one-shot `dsh --profile headless --json` process, and each one leaves a session under `~/.dsh/sessions/`. The footer of each result names the session, for example `dsh session: session-… · model: deepseek-flash · mode: read-only`. Continue a session in the terminal with `dsh tui --resume <session-id>`.

Job records live in the plugin data directory, scoped to the repository and to the Claude session. Ending the Claude session cancels that session's running jobs, including jobs it started in other directories with `--cwd`.

## Limits

- dsh is a release candidate, so flags and event names may change. `/dsh:setup` warns when the version is outside the supported range.
- No session pruning yet. Old dsh sessions stay under `~/.dsh/sessions/`.
- No `--effort` option, and no stop-time review gate.
- The plugin only knows the permission mode it started a session with. If you change a session's mode yourself in `dsh tui --resume`, the plugin's footer and its `--read-only` check no longer reflect it.
- Foreground runs are limited by Claude Code's Bash timeout (the commands ask for 10 minutes). Use `--background` for longer work.

## Help and contributing

- [docs/troubleshooting.md](docs/troubleshooting.md) covers common problems.
- [SUPPORT.md](SUPPORT.md) explains where to ask for help and what to include.
- [SECURITY.md](SECURITY.md) explains how to report a vulnerability privately.
- [CONTRIBUTING.md](CONTRIBUTING.md) covers development, tests and releases.
- [docs/dsh-compat.md](docs/dsh-compat.md) lists everything the plugin relies on in dsh.
- [plugins/dsh/CHANGELOG.md](plugins/dsh/CHANGELOG.md) lists changes by version.

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
