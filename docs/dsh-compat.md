# dsh compatibility

Everything the plugin assumes about DeepSeek Harness (dsh), with a command to
check each assumption and the plugin code that depends on it.

Verified against `@deepseek-ai/dsh@0.2.0-rc.2`. The supported range is
`>=0.2.0-rc.2 <0.3.0` (`SUPPORTED_RANGE` in `plugins/dsh/scripts/lib/dsh.mjs`).
dsh is a release candidate and does not promise compatibility yet.

When upgrading dsh, check every row here first. Then update the range, the
fake dsh in `tests/fake-dsh-fixture.mjs` and this page together. When the plugin
starts relying on something new from dsh, add a row in the same pull request.

## Installation

| Assumption | How to check | Used by |
|---|---|---|
| The CLI is published as `@deepseek-ai/dsh` and installs a `dsh` binary. | `npm view @deepseek-ai/dsh bin version` | `/dsh:setup` install offer, `handleSetup` next steps |
| Installing it also puts `dsh-tui` on `PATH`, used to log in with `/login`. | `which dsh-tui` after a global install | `handleSetup` login hint, README |
| `dsh --version` exits 0 and prints a semver version, possibly with a pre-release suffix. | `dsh --version` | `getDshAvailability`, `isSupportedDshVersion` |

## Launcher

| Assumption | How to check | Used by |
|---|---|---|
| `--patch <file>` adds an overlay applied after the profile layer, and `--profile <name>` picks the profile. Both come before app arguments. | `dsh --help` | `runHeadless` |
| The `headless` profile ships with dsh. | `dsh --profile headless --help` | `runHeadless` |
| `dsh tui --resume <session-id>` opens a stored session. | `dsh --help` (Examples) | Result footer, README, troubleshooting |

## Headless app

| Assumption | How to check | Used by |
|---|---|---|
| `-` as the task reads it from stdin. The plugin always sends the prompt on stdin. | `dsh --profile headless --help` | `runHeadless` |
| `--json` writes newline-delimited JSON events to stdout. | `dsh --profile headless --help` | `runHeadless`, `parseEventLine` |
| `--session-id <id>` adopts an existing session, and an unknown id is an error. | `dsh --profile headless --help` | `/dsh:rescue --resume` |
| A non-zero exit code means the run failed. Diagnostics go to stderr. | `dsh --profile headless --help` | `runHeadless` error handling |
| Every run stores a session under `~/.dsh/sessions/`. | `ls ~/.dsh/sessions` after a run | README, SECURITY.md |

## JSON events

The plugin reads only these event types and fields and ignores everything else.
Lines that are not JSON objects with a string `type` are skipped.

| Event | Fields read | Used for |
|---|---|---|
| `session` | `sessionId` | The session id in the job record and result footer |
| `final` | `text` | The final answer |
| `error` | `message` | The error shown when a run fails |
| `status` | `usage` | Token usage stored with the job |

Check with `dsh --profile headless --json "Reply with OK"`.
`tests/fixtures/headless-sample.jsonl` holds a recorded sample.

## Patch rows

Each run writes a temporary patch file with these rows
(`writeRunPatch` in `plugins/dsh/scripts/lib/dsh.mjs`). Check that the ids still
exist with `dsh --profile headless --dump-config`, and check their schemas with
`dsh --dump-config-schema`.

| Row id | Config the plugin sets | Why |
|---|---|---|
| `sandbox-policy` | `mode` (`read-only` or `workspace-write`) and `workspaceRoot` | Pins the sandbox to the requested mode and to the working directory |
| `permission` | `defaultPreset` set to the run's mode, and a `presets` table where every preset uses `approval: ask` | The default preset is pinned into new sessions, so it must match the sandbox mode. `ask` fails closed because headless has no approval channel. |
| `agent-default-model` | `provider: deepseek-official` and `model` | Only written when `--model` is passed |

The plugin also sets `DSH_PERMISSION_MODE` to the same mode in the dsh process
environment.

## Models

| Assumption | How to check | Used by |
|---|---|---|
| With no model row, dsh uses its own default model, `deepseek-flash`. | `dsh --profile headless --dump-config` (`agent-default-model`) | `DEFAULT_MODEL`, shown in the footer |
| `deepseek-v4-pro` is a valid model id for the `deepseek-official` provider. | Run once with `--model pro` | `MODEL_ALIASES` |
| Other model ids are passed to dsh unchanged. | — | `normalizeModel` |
