/**
 * A safe HTTP error that may cross the Worker route boundary.
 *
 * Domain and infrastructure modules use this low-level type without importing
 * tenant request orchestration. The Worker entry point is the only place that
 * turns it into an HTTP response.
 */
export class RouteError extends Error {
  constructor(
    message: string,
    readonly reason: string,
    // 503 is reserved for deployment conditions such as a missing KEK or a
    // development-only route requested in an environment that does not have it.
    readonly status: 400 | 403 | 404 | 409 | 422 | 429 | 503 = 400,
  ) {
    super(message);
    this.name = 'RouteError';
  }
}
