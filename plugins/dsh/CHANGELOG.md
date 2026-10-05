# Changelog

## 0.1.0

- `/dsh:setup`, `/dsh:plan`, `/dsh:review-plan`, `/dsh:rescue`, `/dsh:status`, `/dsh:result` and `/dsh:cancel`.
- `dsh-rescue` subagent and the `dsh-cli-runtime` and `dsh-result-handling` skills.
- SessionStart and SessionEnd hooks that scope jobs to the Claude session and clean them up.
- Plan and review-plan runs are read-only. Rescue writes by default, or runs read-only with `--read-only`.
