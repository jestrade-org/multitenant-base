# multitenant-base

A reusable base for multi-tenant applications: **companies (tenants), their users, roles
and permissions**, with the platform foundations already built — tenant isolation,
sessions, authorization, an append-only audit trail, API keys, plans and quotas, job
queues and a platform panel for staff. Fork it and add your own bounded contexts.

It was derived from Virtual CFO with every finance- and Colombia-specific module removed,
and no AI integration. ADR 0001 (`docs/adr/0001-multitenant-base-scope.md`) records what
was kept, what was removed and why.

## Stack

| Layer    | Technology                                            |
| -------- | ----------------------------------------------------- |
| Frontend | React 18 + TypeScript + Vite, TanStack Query          |
| Backend  | Node.js (ESM) + TypeScript, Fastify, pg-boss          |
| Database | PostgreSQL 17 (via Supabase), schema-per-tenant + RLS |
| Auth     | Supabase Auth (GoTrue), httpOnly cookie sessions      |
| Testing  | Vitest, React Testing Library                         |
| Tooling  | pnpm workspaces, ESLint, Prettier                     |

## What you get

**Companies.** Platform staff register a company; provisioning creates its Postgres schema,
applies the tenant migrations, provisions its storage root and invites its first
administrator. Companies can be suspended and resumed; each has a plan with quotas.

**Users.** A company administrator invites people, assigns roles, deactivates and
reactivates them, and defines the company's own roles from the capability catalogue. The
last administrator cannot be removed; nobody can deactivate themselves.

**Platform panel.** Staff manage companies, plans and quotas, watch the job queues
(replaying or discarding dead-lettered jobs), search the cross-tenant audit trail, and
can enter a company as one of its users through an expiring, audited support-access grant.

**API keys.** Company administrators issue, rotate and revoke keys scoped to a subset of
their own capabilities.

## Architecture

Domain-Driven Design, organized by **bounded context first, layer second**:

```
apps/
  api/                      single Node service: HTTP API, workers, composition root
  web/                      React client, colocated by bounded context
packages/
  <context>/
    src/domain/             entities, value objects, policies, domain events
       application/         use cases, ports, DTOs
       infrastructure/      Postgres repositories and adapters
    src/index.ts            the context's entire public API
  shared-kernel/            Money, Result, errors, events, capabilities
supabase/
  migrations/               control-plane SQL — source of truth for the schema
  tenant-migrations/        applied to every tenant schema
tools/                      build tooling and its fixtures
```

| Package         | Responsibility                                                       |
| --------------- | -------------------------------------------------------------------- |
| `shared-kernel` | `Money`, `Result`, errors, ports, domain events, capability model    |
| `tenancy`       | Company onboarding, plans and quotas, lifecycle, schema provisioning |
| `iam`           | Roles, permissions and company membership                            |
| `integrations`  | API keys                                                             |
| `audit`         | The append-only audit trail and its cross-tenant query               |

Dependencies point inward only — `domain` ← `application` ← `infrastructure` ← delivery.
This is enforced by `eslint.architecture.config.js` (`pnpm lint:arch`), and the rule
itself is covered by `tools/architecture-lint.test.ts`: deliberate violation fixtures that
fail the build if the rule ever stops firing.

### Adding a module

1. Create `packages/<context>/` with `domain/`, `application/`, `infrastructure/` and an
   explicit `src/index.ts`; add it to `tsconfig.json` and to `apps/api`'s references.
2. Tenant tables go in a new `supabase/tenant-migrations/NNNN_<name>.sql`, each one
   calling `app.install_tenant_isolation(:'schema', '<table>')`.
3. New capabilities go in a control-plane migration (`control.permissions` plus the roles
   that get them) and in `packages/shared-kernel/src/domain/permission.ts`.
4. Wire the use cases in `apps/api/src/composition/` (a `with<Context>` function bound to
   the tenant connection, like `platformContext.ts`), add routes, and register them in
   `http/server.ts`.
5. Add the screens under `apps/web/src/contexts/<context>/`, a navigation entry in
   `AppShell.tsx` gated on the capability, and an `es` translation namespace.
6. New events go in `shared-kernel`'s event catalogue and the API's queue routing.

## Tenant isolation

Three defences, and none of them is allowed to be the only one:

1. **The schema is never chosen by hand.** Tenant data is reachable only through a
   tenant unit of work, which has no schema parameter; the connection provider binds
   `search_path` for one transaction. A lint rule fails the build on any SQL that names a
   tenant schema or interpolates an identifier.
2. **RLS evaluates for real.** Tenant queries run as `tenant_app`, a role _without_
   `BYPASSRLS`. `app.install_tenant_isolation` installs the four per-operation policies;
   `pnpm verify:rls` fails CI if any tenant table lacks them.
3. **A leak is a blocking release criterion**, not a coverage goal.

## Getting started

**Prerequisites:** Node 20.19+ (the API image runs Node 22), pnpm, and a Docker runtime (Docker Desktop, OrbStack or
Colima). The Supabase local stack needs roughly 3–4 GB of RAM.

This project runs **its own Supabase instance** (`project_id = "multitenant-base"`) on the
`553xx` port range, and its dev servers on `3100` (API) and `5273` (web), so it can run on
the same machine as another project's stack on the defaults.

```bash
pnpm install
cp .env.example .env     # local defaults; no real secret belongs in it
pnpm supabase start      # Postgres, Auth, Studio — in Docker
pnpm supabase status     # copy ANON_KEY and SERVICE_ROLE_KEY into .env
pnpm build
pnpm migrate:tenants     # apply tenant schema migrations to every active tenant
pnpm seed:auth           # demo users for the seeded companies
pnpm dev                 # API on http://127.0.0.1:3100, web on http://localhost:5273
```

Demo users (local only — `pnpm seed:auth` refuses any non-local auth URL):

| Email                   | Password                  | Role                           |
| ----------------------- | ------------------------- | ------------------------------ |
| `admin@acme.test`       | `local-demo-acme-admin`   | Company administrator (Acme)   |
| `member@acme.test`      | `local-demo-acme-member`  | Member (Acme)                  |
| `admin@globex.test`     | `local-demo-globex-admin` | Company administrator (Globex) |
| `platform@example.test` | `local-demo-platform`     | Platform administrator         |
| `operator@example.test` | `local-demo-operator`     | Platform operator              |

Check the API is up:

```bash
curl -s localhost:3100/health/ready
```

Local endpoints: Supabase API `:55321`, Postgres `:55322`, Studio `:55323`, email capture
`:55324`.

`supabase/migrations/` is applied by the Supabase CLI to the one shared database.
`supabase/tenant-migrations/` is applied by `pnpm migrate:tenants` to _each_ tenant
schema. Both are idempotent; neither is ever applied to a tenant by hand.
`pnpm supabase db reset` re-applies every migration from scratch and reseeds — run it
before opening a PR that touches the schema.

`pnpm dev` reads `.env`; `pnpm start` deliberately does not, because in a deployed
environment the platform injects configuration. Either way the process refuses to boot on
invalid or missing config rather than guessing.

## Quality gates

```bash
pnpm format:check && pnpm lint && pnpm lint:arch && pnpm typecheck && pnpm test
```

`pnpm test:integration` runs the integration suite against the local Supabase stack.

CI (`.github/workflows/ci.yml`) runs the gates on every push and pull request, plus a
dependency audit, a secret scan, migrations against a fresh database, the tenant migration
step (twice, to prove it idempotent), the RLS verification, and a build of the API
container image that must answer `/health/ready`.

## Conventions

Project instructions live in [`.claude/CLAUDE.md`](.claude/CLAUDE.md), which links the
rule sets in [`.claude/rules/`](.claude/rules/) covering architecture, each technology,
security, and quality.

1. **All code is in English; the UI is in Spanish.** The API returns stable English error
   codes, never translated text.
2. **Dependencies point inward.** A violation fails the build.
3. **Tenant scope comes from the verified token.** RLS on every table, authorization in
   the use case, and an append-only audit trail written in the same transaction as the
   change.
