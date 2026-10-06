# Security

## Supported versions

| Version | Supported |
|---|---|
| Latest release | Yes |
| Older releases | No |

## Reporting a vulnerability

Report vulnerabilities privately through GitHub at
https://github.com/TrungyuD/dsh-plugin-cc/security/advisories/new. Include the
affected version, reproduction steps, impact and any suggested fix. Do not post
exploitable details in a public issue, discussion or pull request before a fix
is released.

The maintainer aims to acknowledge a report within three business days and to
give an initial assessment within seven business days. Updates stay in the
private advisory.

If the problem reproduces with dsh alone, without this plugin, report it to
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) instead.

## Security model

- **Credentials.** The plugin never reads, stores or sends your DeepSeek
  credentials. dsh handles login (`dsh-tui`, then `/login`) and uses the
  credentials itself when the plugin starts it.
- **Permissions.** Every run gets an explicit sandbox mode through a per-run
  patch and `DSH_PERMISSION_MODE`. `/dsh:plan` and `/dsh:review-plan` always run
  `read-only`. `/dsh:rescue` runs `workspace-write` by default and `read-only`
  with `--read-only`. A resumed session keeps the mode it was created with.
- **Approvals.** Every permission preset uses the `ask` approval policy. Headless
  dsh has no approval channel, so any request to escalate fails instead of being
  granted. The plugin never uses `never`, which auto-approves.
- **Read-only scope.** Read-only protects your workspace. dsh still writes its own
  sessions, logs and profile under `~/.dsh/`.
- **Background processes.** Background jobs run as detached processes. The
  SessionEnd hook cancels the jobs that the ending Claude session started from its
  starting directory, and `/dsh:cancel` stops a job and its process group.
- **Local state.** Job records and logs are stored in the plugin data directory
  (`CLAUDE_PLUGIN_DATA`, or a `dsh-companion` folder in the OS temp directory)
  with owner-only permissions. Logs contain your prompts and dsh's output.
- **Network.** The plugin itself makes no network calls. dsh contacts the
  DeepSeek provider. `/dsh:setup` offers to run `npm install -g @deepseek-ai/dsh`
  and only runs it after you agree.

## Disclosure and credit

After a fix is released, the maintainer coordinates disclosure and release notes
with the reporter. Reporters are credited when they ask to be, unless that would
expose sensitive information.
