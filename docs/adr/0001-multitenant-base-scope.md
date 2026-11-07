# ADR 0001 — A reusable multi-tenant base, derived from Virtual CFO

- **Status:** accepted
- **Date:** 2026-11-07
- **Deciders:** Jesús Estrada

## Context

This repository started as a copy of Virtual CFO, a financial management product for
Colombian companies. Its platform foundations — tenant isolation, authentication,
role-based authorization, the audit trail, the transactional outbox, the job queues and
the platform panel — are not specific to finance, and they are the expensive part to get
right. Every new multi-tenant project would otherwise rebuild them.

## Decision

This repository is a **reusable base for multi-tenant applications**: create companies
(tenants) and their users, and nothing domain-specific on top. Projects fork it and add
their own bounded contexts.

### What the base keeps

| Package         | Responsibility                                                       |
| --------------- | -------------------------------------------------------------------- |
| `shared-kernel` | `Money`, `Result`, errors, ports, domain events, capability model    |
| `tenancy`       | Company onboarding, plans and quotas, lifecycle, schema provisioning |
| `iam`           | Roles, permissions and company membership                            |
| `integrations`  | API keys                                                             |
| `audit`         | The append-only audit trail and its cross-tenant query               |

Plus, in `apps/api`: Supabase Auth sessions (httpOnly cookies, CSRF, refresh rotation),
tenant resolution, schema-per-tenant connections under RLS, the outbox poller, pg-boss
queues with dead-letter management, the scheduler, and support access for platform staff.
In `apps/web`: sign-in, profile and theme, company user and role administration, and the
platform panel (companies, plans, queues, audit, support access).

### What was removed

Everything that only made sense for Virtual CFO: the `diagnostics`, `ingestion`,
`financial-engine`, `advisory`, `collections` and `notifications` contexts; their routes,
workers, screens, translations and tenant tables; the AI providers (Gemini, Ollama) and
their configuration; the Colombian specifics (`Nit`, `Period`, COP and Bogotá defaults,
DIAN rules); and the financial-domain rule set.

There is **no AI integration** in the base. A project that needs one adds it as its own
adapter, behind its own ADR on data egress.

### Generic choices that replaced Colombian ones

- A company's `tax_id` is a normalised, format-agnostic identifier (3–30 letters and
  digits). A project serving one jurisdiction replaces it with a validating value object.
- New companies default to `UTC`; the operator states the timezone.
- Plans are priced in `USD`, `EUR` or `COP` and limit **active users** only. A project adds
  its own quota kinds next to `users`.
- Lifecycle states are `onboarding`, `active`, `suspended`, `terminated`.
- Base roles: `platform_admin`, `platform_operator` (platform staff), `tenant_admin` and
  `member` (company users). Capabilities are data; a project adds its own in a migration
  and mirrors them in `permission.ts`.

### Its own Supabase instance and Docker stack

The base runs against **its own local Supabase instance** (`project_id =
"multitenant-base"`), on the `553xx` port range instead of the default `543xx`, and the
local API and web dev servers use `3100` and `5273`. Its containers, volumes and network
are therefore distinct from Virtual CFO's, and both stacks can run on one machine at the
same time. The staging compose project is named `mtb-staging` for the same reason.

### A fresh migration history

The control-plane migrations were edited in place rather than corrected by new
migrations. The rule against editing an applied migration protects databases that have
applied it; no database has applied this repository's migrations — the base gets a new
Supabase instance — so the history starts clean, without CFO columns created only to be
dropped. From this ADR onward, the normal rule applies.

## Consequences

- A project built on this base starts with working sign-in, companies, users, roles,
  API keys, audit and platform operations, and adds only its domain.
- Comments throughout the code still cite section numbers (`§4.3`, `§8.1`) of the
  original technical specification, which is not in this repository. They describe the
  reasoning in place and remain accurate; a project may replace them with its own spec.
- The `notifications` queue exists, and quota warnings are routed to it, but nothing
  consumes it yet: delivering messages is project-specific.
