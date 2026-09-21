# Simulated effect execution

Outside production, pressing Execute on a legacy effect answers with an invented
outcome so an invoice, agreement or admission can be followed to the end in a
demo. The outcome is recorded under its own status, `simulated`. It is never
`executed`, and no bank, signing service, mail provider or access system is
contacted.

## Where it is on

| Environment | `EFFECT_EXECUTOR_MODE` | Execute answers |
|---|---|---|
| development | `simulated` | `simulated` |
| staging | `simulated` | `simulated` |
| production | `unavailable` | `unavailable`, and the code ignores the variable |

`effectExecutorMode` in `apps/worker/src/domain/effects.ts` returns
`unavailable` whenever `ENVIRONMENT` is `production`, whatever the variable
says. `test/unit/effect-simulation.test.ts` asserts that, and
`test/unit/engine-config.test.ts` asserts the checked-in configuration matches.

## What a simulation writes

One `effects` row moves from `pending` to `simulated`. Its `enforcement_result`
holds `result: 'simulated'`, the honest reason sentence, who pressed Execute,
and a `simulation` object:

- `reference`, visibly synthetic: `SIM-PAY-…`, `SIM-SIG-…`, `SIM-MSG-…`, `SIM-ACC-…`.
- `summary`, one line that names the kind and says what did not happen, for
  example `USD 900.00 to Robin Ellis · simulated settlement · no money moved`.
- `steps`, a short provider-style timeline, all timestamps in the past so the
  receipt reads settled rather than in flight. Nothing polls or updates it.

The summary echoes a few request facts read inside the tenant transaction:
payee and total for an invoice, document number and party names for an
agreement, the applicant for an admission. Missing facts are omitted, not
invented.

One `effect.executed` audit row is appended, the same kind as an unavailable
attempt. History renders it as "Maya simulated Pay the invoice" with the
summary as its detail. A second press returns the existing row and appends
nothing.

## What the client shows

Bootstrap advertises `capabilities.effect_executor`. When it is `simulated`:

- the pending row's button reads **Execute (simulated)**, never Execute;
- the honesty paragraph explains that this environment invents outcomes and
  that no email is sent, no money moves, no access changes and nothing is signed;
- a simulated row carries a **Simulated** pill, the summary as its status line,
  and the timeline beneath it;
- the document view's disclosure reads "Downstream actions simulated" and lists
  each effect with its reference.

An older Worker that does not advertise the field is read as `unavailable`, so
the client never offers a simulated Execute the server would not honour.

## What it is not

- Not a stub that returns `executed`. That status is still written nowhere.
- Not provider code. Invariant 5 in [CONVENTIONS.md](CONVENTIONS.md) stands.
- Not the generalized approval effect outcome. `approval_requests.effect_status`
  is unchanged and still reports `unavailable` for provider effects.
- Not a path to production. Turning it on there requires changing
  `effectExecutorMode`, which the unit test will fail.
