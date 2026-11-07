# Node.js / Backend

Applies to: `apps/api/`, `packages/*/src/infrastructure/`.

## Runtime

- Node 20+ LTS, pinned in `.nvmrc` and `engines`. ESM (`"type": "module"`).
- TypeScript compiled with `tsc`; no runtime transpilation in production.
- Fastify as the HTTP server. Route handlers stay thin — see `@.claude/rules/api-design.md`.

## Composition root

Wiring happens in exactly one place (`apps/api/src/composition/`): construct
repositories, adapters, and use cases there and inject them. No service locator, no
singletons imported across modules, no `new SupabaseClient()` scattered in handlers.

## Configuration

- All config from environment variables, validated **once at startup** with Zod. The
  process refuses to boot on invalid or missing config — never fall back to a default
  for a secret or a URL.
- `process.env` is read only in the config module. Everywhere else takes typed config.
- `.env.example` lists every variable with a description and a non-secret sample.
  `.env*` is gitignored. Secrets come from the platform's secret manager in deployed
  environments.
- No environment checks scattered through business code (`if (NODE_ENV === 'prod')`).
  Inject behavior instead.

## Middleware order (Fastify)

1. Request ID / correlation ID
2. Structured logger (pino) bound to the request
3. Helmet (security headers), CORS with an explicit origin allowlist
4. Body limit (`bodyLimit`, default 1 MB) and rate limiting
5. Authentication (JWT verification)
6. Route-level schema validation (Zod)
7. Authorization inside the use case
8. Central error mapper (last)

## Processes & resilience

- Graceful shutdown: handle `SIGTERM`, stop accepting connections, drain in-flight
  requests, close the DB pool, exit. Kubernetes/Fly will kill you otherwise mid-write.
- Health endpoints: `/health/live` (process up) and `/health/ready` (DB reachable).
  Readiness must actually check dependencies.
- Every outbound HTTP call: explicit timeout, bounded retries with exponential backoff
  **and jitter**, and retries only on idempotent operations.
- Circuit-break third parties (identity providers, payment gateways, email) so one slow dependency
  can't exhaust the event loop.
- Never block the event loop. CPU-heavy work (PDF generation, large report
  aggregation, CSV parsing of big files) goes to a worker thread or a background job.
- Long jobs run as queued background work with idempotent handlers, not inside a request.

## Scheduled & background work

- Jobs are idempotent and safe to run twice — assume at-least-once delivery.
- Every job takes a distributed lock (Postgres advisory lock) if it must be singleton.
- Jobs log start, end, duration, and items processed; failures alert.
- Anything that moves money or submits to an external authority records an outbox entry before
  acting and is reconciled after.

## Dependencies

- Justify every new dependency: maintenance, size, transitive count, license.
- No dependency added to `domain/` — ever.
- Pin with a lockfile; `pnpm audit` runs in CI and blocks on high severity.
- Prefer the standard library and small focused packages over frameworks-inside-frameworks.
