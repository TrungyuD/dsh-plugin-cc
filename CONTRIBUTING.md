# Contributing

Thanks for your interest in dsh-plugin-cc. Bug reports, fixes and focused
improvements are welcome.

## Before you start

1. Search the existing issues and pull requests.
2. For a behavior change, open an issue first so the scope can be agreed before
   you write code.
3. Never report a vulnerability in a public issue. Follow [SECURITY.md](SECURITY.md).

## Development

```
git clone https://github.com/TrungyuD/dsh-plugin-cc.git
cd dsh-plugin-cc
npm test
```

There is no install step. The project has no runtime or development
dependencies, and the tests use a fake `dsh` binary, so they need neither
network access nor credentials. CI runs `npm test` on Ubuntu and macOS with
Node.js 18, 20 and 22.

To try your changes in Claude Code, add your clone as a local marketplace:

```
/plugin marketplace add /path/to/dsh-plugin-cc
/plugin install dsh@dsh-plugin-cc
/reload-plugins
```

## Ground rules

1. `npm test` passes before and after your change. Add or update tests for
   behavior changes.
2. No npm dependencies. Use Node.js built-ins only.
3. Code and docs change in the same pull request. Update the README for
   user-visible changes, [docs/troubleshooting.md](docs/troubleshooting.md) for
   new failure modes, and [docs/dsh-compat.md](docs/dsh-compat.md) when the plugin
   starts relying on a new dsh flag, event, patch row or path.
4. Any change under `plugins/` or `.claude-plugin/` bumps the version and adds a
   section for it at the top of [plugins/dsh/CHANGELOG.md](plugins/dsh/CHANGELOG.md). Claude
   Code caches an installed plugin by its version, so an unbumped change does not
   reach users. The version lives in four places that must match:
   - `package.json`
   - `plugins/dsh/.claude-plugin/plugin.json`
   - `.claude-plugin/marketplace.json` (`metadata.version` and the plugin entry)

   `npm test` fails when they differ or when the newest changelog section is not
   the current version.
5. Credit third-party code in [NOTICE](NOTICE) with its correct license, in the
   same commit that adds it.
6. Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`,
   `fix:`, `docs:`, `test:`, `ci:`, `chore:`).

## Releasing

1. Bump the four version fields and add the changelog section.
2. Run `npm test`.
3. Commit as `chore: release X.Y.Z`, tag `vX.Y.Z` and push the commit and tag.
4. Run `npm publish`.
