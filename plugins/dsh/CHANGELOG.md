# Changelog

## 0.3.0

- New `/dsh:code-review`: dsh reviews your local git changes (working tree, or the branch against a base) and answers with a verdict and findings. It is read-only and takes optional focus text after ` -- `, `--base <ref>` and `--scope auto|working-tree|branch`.

## 0.2.0

- `/dsh:plan` saves the plan as `plans/<YYMMDD-HHmm>-<slug>/plan.md` after dsh finishes, so `/dsh:review-plan` offers it next. dsh itself stays read-only.
- Request text reaches dsh exactly as typed: the commands pass flags, then ` -- `, then the text, and the companion no longer drops quotes or backslashes from it.
- Ending a Claude session cancels its running jobs in every workspace it used, including those started with `--cwd` elsewhere.

## 0.1.1

- Fix `npm test` on Node 18 (the unsupported `--test-timeout` flag is gone, and the fake dsh test fixture loads as ESM).
- README: marketplace install command and npm links.

## 0.1.0

- `/dsh:setup`, `/dsh:plan`, `/dsh:review-plan`, `/dsh:rescue`, `/dsh:status`, `/dsh:result` and `/dsh:cancel`.
- `dsh-rescue` subagent and the `dsh-cli-runtime` and `dsh-result-handling` skills.
- SessionStart and SessionEnd hooks that scope jobs to the Claude session and clean them up.
- Plan and review-plan runs are read-only. Rescue writes by default, or runs read-only with `--read-only`.
