# Security

Hermes Teams Demo is an independent open-source project. If you find a
vulnerability, please report it privately rather than opening a public issue.

- Use GitHub's private vulnerability reporting on this repository
  (Security → Report a vulnerability), or
- email brian@boost.xyz with "hermes-teams-demo" in the subject.

Include the affected route, migration or component, steps to reproduce, and
the impact you believe it has. You should hear back within five business days.

## What counts

The product's central promise is that consequential actions (admissions,
documents, sending, payment, signature) are decided by a human, and that this
is enforced by the database's row-level security and the routes rather than by
UI convention. Anything that lets an agent or a non-member bypass that promise
is in scope. So is any path that reads a stored provider key in plaintext
outside the single provider step that needs it. `docs/SECURITY-REVIEW.md`
records the threat model and the current findings.

## Secrets

No live credentials belong in this repository. `.env`, `.dev.vars` and
`credentials.env` files are ignored; the `.example` files beside them document
what a deployment needs. CI runs gitleaks over the full history on every push,
and GitHub push protection is enabled. If you believe a secret has been
committed, report it through the channels above so it can be rotated and the
history rewritten.
