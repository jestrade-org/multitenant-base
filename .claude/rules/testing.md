# Testing

## Strategy per layer

| Layer | Type | Rules |
|-------|------|-------|
| `domain/` | Unit | No I/O, no mocks. Highest value — test invariants and edge cases exhaustively. |
| `application/` | Unit | Real domain objects, in-memory fakes for ports. Never mock what you own with `vi.mock`. |
| `infrastructure/` | Integration | Local Supabase. Real SQL, real RLS. |
| `apps/api` | Integration | Supertest through the real route stack, real DB. |
| `apps/web` | Component | React Testing Library. |
| Critical flows | E2E | Playwright, a handful only. |

Shape: many domain unit tests, a solid layer of integration tests, few E2E. Do not
invert it.

## Rules

- **Test behavior, not implementation.** If a refactor that changes no behavior breaks
  the test, the test is wrong.
- Test names are English sentences describing behavior:
  `it('refuses to deactivate the last administrator')` —
  not `it('works')`, not `it('test member 2')`.
- Arrange–Act–Assert, visually separated. One logical assertion per test.
- Deterministic: inject `Clock` and `IdGenerator`; never `new Date()` or random values in
  a test. No dependence on test order, timezone, or locale — CI runs with `TZ=UTC`.
- No sleeps. Await conditions with `waitFor` or explicit fakes.
- No conditionals or loops in test bodies. Use `test.each` for tables of cases.
- Fakes over mocks for owned interfaces (`InMemoryRoleRepository`). Mock only true
  external boundaries.
- Every bug fix ships with a regression test that fails before the fix. No test, no fix.

## What must be tested

- Every domain invariant and every branch of a business rule.
- Every calculation, with worked examples in the name, including: boundaries (a quota
  exactly at its limit), zero and negative amounts, currency mismatches, timezone day
  boundaries, and leap-year/month-end dates.
- **Every tenant-scoped table: a cross-tenant isolation test** proving a member of
  company A cannot read, update, or delete company B's rows.
- **Every ID-taking endpoint: an authorization negative test** (unauthenticated,
  wrong tenant, insufficient role).
- Idempotency: sending the same request twice produces one effect.
- Concurrency: two simultaneous updates to one aggregate — one wins, one gets a conflict.
- The four UI states of every async view: loading, empty, error, success.
- Accessibility of interactive views with `axe`.

## Fixtures

- Builders with sensible defaults over literal object soup:
  `aMember().withRole('tenant_admin').inactive().build()`.
- Synthetic, realistic data: the seeded companies (Acme Logistics, Globex Corporation),
  plausible names and emails on `.test` domains, amounts as `Money`.
- **Never real customer data**, in any environment or fixture.
- Each test creates its own data and cleans up. No shared mutable fixtures, no
  dependence on seed state.

## Coverage & CI

- Coverage is a signal, not a target. Expected floors: `domain/` and `application/`
  ≥ 90%, overall ≥ 80%. Coverage may not drop in a PR.
- 100% coverage of a module with no assertions on invariants is worthless — review the
  assertions, not the number.
- CI runs lint, typecheck, unit, integration, and a smoke E2E on every PR. All green
  before merge; no `.skip`, no `.only`, no commented-out tests on `main`.
- Flaky tests are quarantined with an owner and an issue within 24 h, then fixed or
  deleted. A tolerated flaky test rots the whole suite.
