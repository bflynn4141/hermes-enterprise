# Dagger checks for coding agents

Dagger runs the fast Hermes checks and deployable build in a disposable Linux
container. Contributors and coding agents use the same pinned toolchain without
installing the application dependencies on their host. It does not deploy, call
a model, or connect to a development or production database.

## Run

Install the **Dagger 0.21.9 CLI** and start Docker (Docker Desktop or Colima).
Use that CLI's default engine; `engineVersion` records module compatibility
and does not override a separately configured engine. The current Dagger 1.0 beta
uses a different workspace format; use this repository's pinned stable version.
For installation, use the [official installer](https://docs.dagger.io/getting-started/install/)
with `DAGGER_VERSION=0.21.9`, or the checksum-verified binary from
[the release](https://github.com/dagger/dagger/releases/tag/v0.21.9).

From the repository root:

```sh
dagger call check             # quick checks, then the build
dagger call quick             # import graph, types and unit tests only
dagger call build             # compile app and dry-run the Worker bundle
```

Equivalent aliases are `pnpm dagger:check`, `pnpm dagger:quick` and
`pnpm dagger:build`. The direct Dagger commands do not require host Node or pnpm.
The first run downloads the engine, Node image and packages. Later runs reuse
Dagger's content-addressed layers and a pnpm download cache. A failed command
returns a nonzero exit status; an agent must fix or report the failure before
claiming verification. Dagger may reuse a successful result when its inputs
are unchanged. That is a cached result, not a newly executed test run.

## What runs

The TypeScript module is in `.dagger/src/index.ts`, configured by `dagger.json`.
It uses a digest-pinned Node 26 Debian image, pnpm 11.10.0 and the repository's
frozen lockfile. Dependency manifests form their own installation layer, so
ordinary source edits do not require installing the dependency tree again.

`check` runs the existing `pnpm check:quick` (import-cycle lint, workspace
TypeScript checks and shared/client/Worker unit tests), then `pnpm build`.
The build includes motion components, shared package, client, and the Worker's
Wrangler dry run. This is a fast contributor loop, not full CI parity.

## Source and credentials

The source argument filters local `.env`/`.dev.vars` files, private key files,
`.npmrc`, nested Git/dependency directories, worktrees, tool state, runtime
`.state`, generated reports and build outputs before importing the source.
Example environment files remain available to policy tests. The committed
motion-components build remains available for workspace imports.

The module forwards no host environment variables, credentials, home directory,
Docker socket or database URLs to check containers. Wrangler telemetry is off.
Dagger's engine uses the host Docker service; the checks themselves receive no
host Docker access. No Dagger Cloud account or paid runner is required. Only run
trusted branches on a local engine: dependency installation and checks execute
code from the checkout. Do not treat source filters as a general secret scanner.

## Agent workflow

1. Implement in an isolated worktree.
2. Run `dagger call check` for quick checks and build, or `dagger call quick`
   while iterating.
3. Run additional existing suites for changes that need them, as described in
   `AGENTS.md`. Record the commit, command and whether the result was cached.
4. Open the PR with the verification result. Existing required GitHub checks
   and deployment gates still apply.

Database, workerd, browser, runtime-canary, workflow-lint and secret-scanning
checks are not moved into Dagger in this increment. Use their existing commands
and CI paths. In particular, database tests verify ownership of a disposable
Docker container; a Dagger service needs an explicit isolation design before it
can replace that path. Never fake `GITHUB_ACTIONS` to bypass that verification.

GitHub still runs its existing checks and staging/production workflows. This
change establishes the local agent loop; it does not remove Actions, shorten
its required test gate, or claim a measured cloud-cost saving. A later cutover
must preserve required check results and deployment of the verified commit.
