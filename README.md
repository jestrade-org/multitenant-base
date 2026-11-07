# virtual-cfo

Financial management, accounting, cash flow and tax compliance for small and mid-sized
companies in Colombia (DIAN). Locale `es-CO`, currency `COP`.

> **Status: early.** The workspace, the tenant isolation, the shared kernel, the
> transactional outbox and a first dashboard screen are in place and run locally. Most
> bounded contexts are still empty shells, and there are no authenticated business
> endpoints yet — the web client reads fixtures and says so on screen.

## Stack

| Layer    | Technology                                              |
| -------- | ------------------------------------------------------- |
| Frontend | React 18 + TypeScript + Vite, TanStack Query, RHF + Zod |
| Backend  | Node.js 20+ (ESM) + TypeScript, Fastify                 |
| Database | PostgreSQL 15 (via Supabase)                            |
| Platform | Supabase (Auth, Storage, Realtime, Edge Functions, RLS) |
| Testing  | Vitest, React Testing Library, Playwright               |
| Tooling  | pnpm workspaces, ESLint, Prettier, Husky                |

## Architecture

Domain-Driven Design, organized by **bounded context first, layer second**:

```
apps/
  api/                      single Node service: HTTP API, domain and workers
  web/                      React client, colocated by bounded context
packages/
  <context>/
    src/domain/             entities, value objects, policies, domain events
       application/         use cases, ports, DTOs
       infrastructure/      Supabase repositories, queue and provider adapters
       interface/           controllers, webhook handlers
    src/index.ts            the context's entire public API
  shared-kernel/            Money, Result, base classes, domain events
supabase/
  migrations/               SQL — source of truth for the schema
tools/                      build tooling and its fixtures
```

Bounded contexts, one package each:

| Package            | Responsibility                                              |
| ------------------ | ----------------------------------------------------------- |
| `tenancy`          | Client onboarding, plans, lifecycle, schema provisioning    |
| `iam`              | Identification, authentication, role-based authorization    |
| `diagnostics`      | The seven-day initial diagnostic cycle                      |
| `ingestion`        | Receipt, validation and reconciliation of financial data    |
| `financial-engine` | Indicators, receivables aging, cash flow projection         |
| `advisory`         | CFO IA diagnosis and recommendations, gated on human review |
| `collections`      | Risk classification, prioritisation, collection messages    |
| `notifications`    | Alerts, reports, WhatsApp and email channels                |
| `integrations`     | Public API, API keys and secrets, webhooks                  |
| `audit`            | Immutable record of access and actions                      |

Adding a context is an architectural decision — ask first.

Dependencies point inward only — `domain` ← `application` ← `infrastructure` ←
delivery. This is enforced by `eslint.architecture.config.js`, which runs as its own CI
step (`pnpm lint:arch`), and the rule itself is covered by
`tools/architecture-lint.test.ts`: deliberate violation fixtures that fail the build if
the rule ever stops firing.

## Tenant isolation

Three defences, and none of them is allowed to be the only one:

1. **The schema is never chosen by hand.** Tenant data is reachable only through a
   `TenantUnitOfWork`, which has no schema parameter; the connection provider binds
   `search_path` for one transaction. A lint rule fails the build on any SQL that names a
   tenant schema or interpolates an identifier.
2. **RLS evaluates for real.** Tenant queries run as `finia_app`, a role _without_
   `BYPASSRLS` — the role the API connects with has it, which would have made every
   policy decorative. `app.install_tenant_isolation` installs the four per-operation
   policies; `pnpm verify:rls` fails CI if any tenant table lacks them.
3. **A leak is a blocking release criterion**, not a coverage goal.

The domain layer additionally may not read the system clock, call `Math.random()`, or
touch `process` — time and identity arrive through injected ports, so a financial
calculation is reproducible and testable.

## Getting started

**Prerequisites:** Node 20+, pnpm, and a Docker runtime (Docker Desktop, OrbStack or
Colima). The Supabase local stack needs roughly 3–4 GB of RAM.

```bash
pnpm install
cp .env.example .env    # local defaults; no real secret belongs in it
supabase start          # Postgres, Auth, Storage, Studio — in Docker, ~10 containers
pnpm build
pnpm migrate:tenants    # apply tenant schema migrations to every active tenant
pnpm dev                # the API, on http://127.0.0.1:3000
```

`pnpm dev` reads `.env`; `pnpm start` deliberately does not, because in a deployed
environment the platform injects configuration and there is no `.env` to read. Either way
the process refuses to boot on invalid or missing config rather than guessing.

Check it is up:

```bash
curl -s localhost:3000/health/ready
# {"status":"ready","checks":[{"name":"control-database","status":"ok"}]}
```

Routes under `/api/v1` resolve a tenant first (§4.1). With the seeded fixtures:

```bash
curl -s -H 'Host: andina.finia.app' localhost:3000/api/v1/anything
```

There are no business routes yet, so that answers 404 — the same 404 an unknown tenant
gets, deliberately.

**There is no web client yet.** `apps/web` is not built; "the app" today is the API.

Local endpoints: Supabase API `:54321`, Postgres `:54322`, Studio `:54323`, email capture
`:54324`.

`supabase/migrations/` is applied by the Supabase CLI to the one shared database.
`supabase/tenant-migrations/` is applied by `pnpm migrate:tenants` to _each_ tenant
schema — the CLI has no notion of "run this against N schemas", which is what Option A
needs. Both are idempotent; neither is ever applied to a tenant by hand.

The Supabase CLI is pinned as a workspace devDependency so every developer and CI use
the same version. Local endpoints: API `:54321`, Postgres `:54322`, Studio `:54323`,
email capture `:54324`.

`pnpm supabase db reset` re-applies every migration from scratch and reseeds — run it
before opening a PR that touches the schema.

Development and tests always run against the local stack. Never point a local
environment at production or at a shared database.

## Quality gates

```bash
pnpm format:check && pnpm lint && pnpm lint:arch && pnpm typecheck && pnpm test
```

CI (`.github/workflows/ci.yml`) runs all of these on every push and pull request, plus a
dependency audit, a secret scan, and a build of the API container image that must answer
`/health/ready` before the job passes. Every red step blocks the merge.

CI also starts a local Supabase stack, verifies every migration applies to a database
created from scratch, applies the tenant schema migrations to all active tenants, re-runs
that step to prove it is idempotent, and verifies that every tenant table is isolated.

Not in the pipeline yet, each owned by its own ticket rather than stubbed out: the
integration tests against a local Supabase stack, the migration check against a
production-shaped copy, the RLS tenant-isolation suite, and the smoke E2E. Deployment jobs are deliberately absent —
the reverse proxy and TLS strategy are open decisions, and CI must not bake in a choice
nobody has made.

## Conventions

Project instructions live in [`.claude/CLAUDE.md`](.claude/CLAUDE.md), which links 15
rule sets in [`.claude/rules/`](.claude/rules/) covering architecture, each technology,
security, and quality.

Three rules override everything else:

1. **All code is in English; the UI is in Spanish.** Identifiers, files, database
   objects, comments and commits are English. Spanish exists only in translation files —
   the API returns stable English error codes, never translated text.
2. **Dependencies point inward.** A violation fails the build.
3. **Never represent money as a float.** `Money` value objects, `numeric(19,4)` columns,
   explicit rounding, append-only ledger.

Security controls (IAAA and OWASP) are mandatory, not aspirational: RLS on every table,
authorization checked in the use case, tenant scope derived from the verified token, and
an append-only audit trail written in the same transaction as the change.
# multitenant-base
