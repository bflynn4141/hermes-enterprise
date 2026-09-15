// Minimal stand-ins for the `cloudflare:workers` and `cloudflare:workflows`
// modules, used only by the Node test projects.
//
// They exist so that the Node projects can import the Worker's own module graph
// (the Hono app, the routes, the tenant transaction) and exercise it against
// the real database. Nothing here is exercised as behaviour: the classes that
// extend these base classes are tested in workerd by the `worker` project,
// where the real modules are present.
export class DurableObject<E = unknown> {
  constructor(
    readonly ctx: DurableObjectState,
    readonly env: E,
  ) {}
}

export class WorkflowEntrypoint<E = unknown, P = unknown> {
  constructor(
    readonly ctx: ExecutionContext,
    readonly env: E,
  ) {}
  declare readonly __params?: P;
}

export type WorkflowEvent<P> = { payload: P; timestamp: Date; instanceId: string };
export type WorkflowStep = Record<string, never>;
