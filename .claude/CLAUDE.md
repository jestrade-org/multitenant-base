# CLAUDE.md — multitenant-base

Project instructions for Claude. Read this file first; it links every rule set below.

## Product

A **reusable base for multi-tenant applications**: companies (tenants), their users, roles
and permissions, API keys, plans and quotas, an append-only audit trail, and a platform
panel for staff. Nothing domain-specific — projects fork this repository and add their own
bounded contexts on top (ADR 0001, `docs/adr/0001-multitenant-base-scope.md`).

The UI is Spanish (`es`). **Tenant isolation and authorization outrank every other
concern** — shipping speed, elegance, and cleverness included. A leak between two
companies is the worst defect this codebase can have.

## Stack

| Layer     | Technology                                              |
|-----------|---------------------------------------------------------|
| Frontend  | React 18 + TypeScript + Vite, TanStack Query            |
| Backend   | Node.js (ESM) + TypeScript, Fastify, pg-boss            |
| Database  | PostgreSQL 17 (via Supabase), schema-per-tenant + RLS   |
| Platform  | Supabase Auth (GoTrue); its own local instance          |
| Testing   | Vitest, React Testing Library                           |
| Tooling   | pnpm workspaces, ESLint, Prettier                       |
| Local dev | Supabase CLI (Docker, ports 553xx) + `pnpm dev` native  |

## The three rules that override everything

1. **All code is in English. The UI is in Spanish.** Identifiers, files, DB objects,
   comments, commits — English. Spanish exists only inside translation files.
   → `@.claude/rules/language-i18n.md`
2. **Dependencies point inward.** `domain` ← `application` ← `infrastructure` ← delivery.
   A violation is a failing build, not a review comment.
   → `@.claude/rules/architecture-ddd.md`
3. **Tenant scope comes from the verified token, never the request.** Every query is
   bound to one company; RLS evaluates for real; another company's resource is a 404.
   → `@.claude/rules/security-iaaa.md`

## Repository layout

```
apps/
  web/                      # React client
  api/                      # Fastify HTTP layer, workers, composition root
packages/
  <context>/                # one package per bounded context
    src/domain/ application/ infrastructure/
  shared-kernel/            # Money, Result, errors, events, capabilities
supabase/
  migrations/               # control-plane SQL — source of truth for the schema
  tenant-migrations/        # applied to every tenant schema by `pnpm migrate:tenants`
docs/
  adr/                      # architecture decision records
```

Bounded contexts in the base: `tenancy`, `iam`, `integrations`, `audit` (plus
`shared-kernel`). A project adds its own as new packages. Adding one is an architectural
decision — ask first.

## Rule index

Foundations
- `@.claude/rules/architecture-ddd.md` — bounded contexts, layers, dependency rule, modelling
- `@.claude/rules/language-i18n.md` — English code / Spanish UI, error codes, formatting
- `@.claude/rules/code-style.md` — naming, files, formatting, comments
- `@.claude/rules/typescript.md` — strict mode, types, error handling

Technologies
- `@.claude/rules/react.md` — components, state, forms, a11y, performance
- `@.claude/rules/node.md` — Fastify, config, processes, dependencies
- `@.claude/rules/postgres.md` — schema, migrations, queries, indexes, transactions
- `@.claude/rules/supabase.md` — RLS, keys, Auth, Storage, Realtime, edge functions
- `@.claude/rules/api-design.md` — REST contracts, validation, errors, pagination
- `@.claude/rules/docker.md` — local Supabase stack, dev loop, CI, API image

Security
- `@.claude/rules/security-iaaa.md` — Identification, Authentication, Authorization, Accounting
- `@.claude/rules/security-owasp.md` — OWASP Top 10 + API Top 10 mapped to this stack

Quality
- `@.claude/rules/testing.md` — test strategy per layer, fixtures, coverage
- `@.claude/rules/observability.md` — logging, metrics, tracing, alerting
- `@.claude/rules/git-workflow.md` — branches, commits, PRs, CI, releases

## Working agreements

- **Locate before creating.** Find the bounded context a change belongs to before adding
  a file. If none fits, stop and ask.
- **Extend before duplicating.** Prefer widening an existing value object or use case
  over adding a parallel one.
- **Flag, don't bend.** If a change seems to require breaking the dependency rule, say so
  instead of adding an outward import.
- **Schema changes ship complete:** migration + mapper + RLS policy (tenant tables use
  `app.install_tenant_isolation`) + isolation test, all in the same change.
- **New capabilities ship on both sides:** a migration inserting into
  `control.permissions` and the same code in `packages/shared-kernel/src/domain/permission.ts`.
- **New user-facing text ships with its `es` translation key.** Never leave a raw Spanish
  string in a component "for now".
- **Security-relevant changes** (auth, authorization, RLS, money movement, PII) get an
  explicit note in the PR describing the threat considered.
- **Verify before declaring done:** run `pnpm lint && pnpm lint:arch && pnpm typecheck &&
  pnpm test` and report the real output. Never claim a suite passes without running it.
- **No new dependency in `domain/`.** That layer stays dependency-free. Ask before adding
  a library anywhere else.
- **Don't touch:** applied migrations, `pnpm-lock.yaml` (except via pnpm), generated
  `database.types.ts`, `.env` files.
