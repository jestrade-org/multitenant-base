# Architecture — Domain-Driven Design

Applies to: the whole repository.

## Organization

Organize by **bounded context first, layer second**. Never by technical type
(`controllers/`, `services/`, `models/` at the root is forbidden).

```
packages/<context>/src/
  domain/            entities, value objects, domain events, domain services,
                     repository interfaces, domain errors
  application/       use cases, commands/queries, ports, DTOs, mappers to DTO
  infrastructure/    Supabase repositories, HTTP clients, adapters, DB types
```

## The dependency rule

`domain` ← `application` ← `infrastructure` ← `apps/api` · `apps/web`

Arrows point inward only. Concretely:

- **`domain/`** imports only `shared-kernel` and the standard library. No Supabase, no
  HTTP, no React, no `process.env`, no `Date.now()`, no `Math.random()`, no logger.
  Time and identity come from injected ports (`Clock`, `IdGenerator`).
- **`application/`** orchestrates domain objects behind **ports it declares itself**.
  It never imports from `infrastructure/`.
- **`infrastructure/`** implements those ports. It is the only place
  `@supabase/supabase-js` and generated DB types may appear.
- **Delivery** (`apps/api`, `apps/web`) depends on `application/` only, through the
  composition root.

Enforced by ESLint `import/no-restricted-paths`. A violation fails CI.

## Cross-context communication

- Never import another context's `domain/`.
- Never read another context's tables directly.
- Call the other context's **application layer** through its public `index.ts`, or
  publish/subscribe a **domain event**.
- Shared concepts that genuinely belong to everyone (`Money`, `Result`, `CalendarDate`,
  `CompanyId`, `Result`) live in `shared-kernel` and change only by consensus.

## Modelling

**Entities** have identity and protect invariants.
- No public setters. State changes are intention-revealing methods:
  `member.deactivate()`, not `member.isActive = false`.
- Private constructor + static factories: `Role.createForTenant(...)`, `Role.reconstitute(row)`.

**Value objects** are immutable, validate in the constructor, compare by value.
`Money`, `CalendarDate`, `EmailAddress`, `Subdomain`, `TaxId`.
Make invalid states unrepresentable — validate at construction, never at use.

**Aggregates**
- The aggregate root is the only entry point; outside code never touches its internals.
- One transaction per aggregate.
- Reference other aggregates **by ID**, never by object reference.
- Keep aggregates small. If two things don't need to change atomically, they are two
  aggregates.

**Repositories**
- Interface in `domain/`, implementation in `infrastructure/`.
- Aggregate-oriented: `save(aggregate)`, `findById(id)`, `findActive(companyId)`.
  No `find(criteria: object)` grab-bags, no leaking query builders.
- Return domain objects, never DB rows.

**Domain errors**
- Typed classes extending `DomainError` with a stable `code`.
- Never `throw new Error('...')` in `domain/` or `application/`.

**Use cases** (`application/`)
- One class, one public `execute(command)`, one responsibility.
- Own the transaction boundary and dispatch domain events after commit.
- Take primitives/DTOs in, return DTOs out — domain objects never cross the boundary.
- Authorization is checked here, before any state changes.

**Read models**
- Queries that need no invariants may bypass aggregates: a query handler in
  `application/queries/` reading a Postgres view. Keep the write path aggregate-based.

## Domain events

- Named in past tense: `TenantProvisioned`, `MemberInvited`, `QuotaThresholdReached`.
- Immutable, carry IDs and primitives — never entity references.
- Recorded by the aggregate, dispatched by the use case after the transaction commits
  (outbox table for anything that must not be lost).

## Anti-patterns — reject these in review

- Anemic domain: entities that are bags of getters/setters with logic in a "service".
- Business rules in a React component, route handler, or SQL trigger.
- `domain/` importing anything from `infrastructure/`.
- Generated Supabase types used as domain types or React props.
- A "utils" or "helpers" module accumulating business rules.
- Barrel `index.ts` re-exporting an entire layer (defeats the lint, breaks tree-shaking).
  A context exposes one explicit `index.ts` at the package root, listing only its public API.
