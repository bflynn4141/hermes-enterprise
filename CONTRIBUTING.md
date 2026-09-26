# Contributing

Thanks for looking. This is a demo of a governed agent workspace, published so
people can read how the guarantees are built. Contributions are welcome, and
the bar is the same one the codebase already holds itself to.

## Before you start

- Read `README.md` for what is real and what is stubbed, `AGENTS.md` for the
  code map and invariants, and `docs/DECISIONS.md` for why things are the way
  they are. A change that
  contradicts a recorded decision needs a new decision entry, not a quiet edit.
- `docs/README.md` identifies current references and historical evidence.
  `docs/CONVENTIONS.md` covers naming, migrations, and test layout.

## Local setup

```sh
pnpm install
pnpm db:up            # Postgres 17 in Docker on 127.0.0.1:5433
pnpm db:migrate
pnpm check:quick      # import cycles, typecheck, and fast unit tests
pnpm test             # unit, worker and database tests
pnpm lint:secrets     # pinned, checksum-verified gitleaks scan
```

The application and test suites work offline after dependencies are installed.
The pinned scanner and runtime installers download their verified upstream
artifacts when invoked.

## Pull requests

- One change per PR, with a description that says what a user can now do or
  no longer has to worry about.
- Migrations are append-only. Never edit a shipped migration; add a new one.
- Anything that touches row-level security, the grant matrix, the decision
  route or provider-key handling needs a test that fails without the change.
- CI must be green: import-cycle check, typecheck, tests, migration replay,
  workflow lint, and the secret scan.

## Not accepted

Code that executes outreach, payment, access grants or signature. Those are
`effects` rows a human executes, and the repository is built so that no code
for them exists here. That is a product decision, not a missing feature.
