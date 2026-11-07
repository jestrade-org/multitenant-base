# PostgreSQL

Applies to: `supabase/migrations/`, all SQL in the repo.

## Schema conventions

- `snake_case` everywhere. Tables plural (`tenant_members`), columns singular.
- Primary key: `id uuid primary key default gen_random_uuid()`.
- Foreign keys: `<table_singular>_id`, always with an explicit `references` and an
  `on delete` action chosen deliberately (`restrict` for business and audit records —
  never `cascade` on anything an audit or history row points to).
- Every table has `created_at timestamptz not null default now()` and
  `updated_at timestamptz not null default now()` (trigger-maintained).
- Every tenant-scoped table has `company_id uuid not null references companies(id)`.
- Timestamps are `timestamptz`, stored in UTC. Never `timestamp` without zone.
- Booleans are `not null default false`. Avoid nullable booleans (three-state bugs).
- Constrain at the database level: `not null`, `check`, `unique`. The database is the
  last line of defense for invariants, even though the domain owns them.

## Types

- **Money: `numeric(19,4)`.** Never `float`, `real`, `double precision`, or `money`.
- Percentages/rates: `numeric(9,6)`.
- Enums: Postgres `enum` types for closed domain sets, kept in sync with TS unions.
  Adding a value is a migration; removing one is a breaking change.
- Text: `text` with `check` constraints, not `varchar(n)` guesses.
- Identifiers with legal or structural meaning (tax ids, subdomains, schema names, API key
  prefixes) get a `check` constraint validating format.
- `jsonb` only for genuinely schemaless payloads (external API responses, audit
  snapshots). Never for data you will query or join on regularly.

## Migrations

- `supabase/migrations/` is the **single source of truth**. Never change the schema from
  the Supabase dashboard.
- **Never edit an applied migration.** Add a new one.
- Timestamped, descriptive names in English:
  `20260318120000_add_member_invitations.sql`.
- Every migration is reviewed for: RLS policies on new tables, indexes for new foreign
  keys, and a backfill plan for new `not null` columns.
- Expand → migrate → contract for breaking changes. Deploy in separate releases so the
  running app is never incompatible with the schema.
- Destructive statements (`drop column`, `drop table`, `truncate`) require explicit
  human approval in the PR description and a verified backup.
- Long-running index creation uses `create index concurrently` outside a transaction.
- Test every migration against a copy of production-shaped data before release.

## Queries

- Parameterized queries only. **Never** string-concatenate SQL — see
  `@.claude/rules/security-owasp.md`.
- Select explicit columns; no `select *` in application code (breaks on schema change,
  leaks columns).
- Every list query is paginated with a deterministic sort (`order by created_at, id`).
  Prefer keyset pagination over `offset` for large tables.
- Index every foreign key, every column used in an RLS policy, and every frequent filter.
  Composite indexes lead with `company_id` for tenant-scoped tables.
- Review `explain (analyze, buffers)` for any query on a table expected to exceed
  100k rows. No sequential scans on hot paths.
- Aggregations for reports live in views or materialized views, not in application loops.
- Avoid N+1: batch with `in (...)` or a join, and assert it in tests.

## Transactions & concurrency

- Wrap multi-statement invariants in a transaction; one aggregate per transaction.
- Keep transactions short. Never do network I/O inside one.
- Use optimistic concurrency (`version` column, checked on update) for aggregates that
  can be edited concurrently; return a typed conflict error, never a silent overwrite.
- `select ... for update` only with a consistent lock ordering to avoid deadlocks.
- Default isolation is `read committed`; use `repeatable read`/`serializable` for
  balance calculations that must not see phantoms — and handle serialization failures
  with a retry.

## Append-only records

- Audit and history tables are **append-only**: no `update`, no `delete`. Corrections
  are new rows referencing the original. Enforce with a trigger and a
  `revoke update, delete` grant (see `control.audit_events`).
- Every business row records `created_by` and `created_at`.
- Derived figures (counts, totals) are computed from their source rows, or kept in a
  snapshot table that is reconcilable and periodically verified against the source
  (see `control.tenant_quota_usage`).
