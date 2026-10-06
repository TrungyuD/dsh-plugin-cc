# Support

## Where to get help

- Run `/dsh:setup` and read [docs/troubleshooting.md](docs/troubleshooting.md) first.
- Use the [bug report form](https://github.com/TrungyuD/dsh-plugin-cc/issues/new?template=bug_report.yml) for defects you can reproduce.
- Use the [feature request form](https://github.com/TrungyuD/dsh-plugin-cc/issues/new?template=feature_request.yml) for enhancements and dsh compatibility proposals.
- Report behavior that also happens with dsh alone to [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

## Support scope

Supported: the latest plugin release, with the Node.js versions listed in the
README and dsh `>=0.2.0-rc.2 <0.3.0`, on macOS and Linux.

Not supported: other dsh versions, unreleased dsh builds, the quality of model
answers, provider outages and general Claude Code questions. Windows is untested.

## What to include

- Sanitized `/dsh:setup` output.
- The exact `/dsh:*` command and flags.
- Plugin, dsh, Node.js and operating system versions.
- The job id, and the dsh session id from the result footer.
- The relevant part of the job log (`/dsh:status <job-id>` shows its path), with
  secrets and private paths removed.
- The smallest set of steps that reproduces the problem.

Security vulnerabilities and sensitive logs go through [SECURITY.md](SECURITY.md),
never a public issue.
