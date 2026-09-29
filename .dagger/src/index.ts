/** Local, credential-free checks for Hermes contributors and coding agents. */
import { argument, Container, dag, Directory, func, object } from "@dagger.io/dagger"

@object()
export class HermesChecks {
  /** Repository input after local secrets, dependencies and generated state are excluded. */
  @func()
  source: Directory

  constructor(
    @argument({
      defaultPath: "/",
      ignore: [
        "**/.git", "**/node_modules", "**/.pnpm-store", "**/.wrangler",
        ".dagger", "work", "~", ".agentcash", ".claude", ".codex",
        "**/.env", "**/.env.*", "**/*.env", "**/.dev.vars", "**/.dev.vars.*",
        "!**/.env.example", "!**/.dev.vars.example",
        "**/.npmrc", "**/*.pem", "**/*.key", "**/.DS_Store",
        "**/coverage", "**/test-results", "**/playwright-report", "**/*.tsbuildinfo",
        "apps/client/qa", "apps/client/dist", "apps/worker/dist", "packages/shared/dist",
        "runtime/hermes/.state",
      ],
    })
    source: Directory,
  ) {
    this.source = source
  }

  /** Import graph, workspace types and fast unit suites. No database or browser. */
  @func()
  async quick(): Promise<string> {
    return this.prepared().withExec(["pnpm", "check:quick"]).stdout()
  }

  /** Build the application; the Worker build is an offline Wrangler dry run. */
  @func()
  async build(): Promise<string> {
    return this.prepared().withExec(["pnpm", "build"]).stdout()
  }

  /** Default agent loop: quick checks followed by the deployable build. */
  @func()
  async check(): Promise<string> {
    return this.prepared()
      .withExec(["pnpm", "check:quick"])
      .withExec(["pnpm", "build"])
      .stdout()
  }

  private prepared(): Container {
    return dag.container()
      .from("node:26-bookworm-slim@sha256:662933cf47f013bc8e4beb31a6116448427a82057ba7c42c97e4c5ba766504c2")
      .withEnvVariable("CI", "true")
      .withEnvVariable("WRANGLER_SEND_METRICS", "false")
      .withExec(["npm", "install", "--global", "pnpm@11.10.0"])
      .withWorkdir("/src")
      .withMountedCache("/pnpm/store", dag.cacheVolume("hermes-pnpm-11"))
      .withDirectory("/src", this.source, {
        include: ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "apps/*/package.json", "packages/*/package.json"],
      })
      .withExec(["pnpm", "install", "--frozen-lockfile", "--store-dir", "/pnpm/store"])
      .withDirectory("/src", this.source)
  }
}
