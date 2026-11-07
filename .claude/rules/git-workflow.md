# Git Workflow

## Branches

- `main` is always deployable and protected: no direct pushes, no force pushes.
- Short-lived branches off `main`, English, kebab-case, scoped by context:
  `feat/iam-member-invitations`, `fix/tenancy-subdomain-length`, `chore/bump-fastify`.
- Rebase on `main` before opening a PR. Merge with squash so `main` reads as one commit
  per change.
- Delete the branch after merge.

## Commits

Conventional Commits, **English**, scoped by bounded context:

```
feat(iam): add member invitations
fix(tenancy): reject subdomains longer than a schema name allows
refactor(cash-flow): extract ForecastPeriod value object
chore(deps): bump @supabase/supabase-js to 2.45.0
```

Types: `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `chore`, `build`, `ci`.
Breaking changes: `!` after the scope plus a `BREAKING CHANGE:` footer.

- Subject in the imperative, ≤ 72 chars, no trailing period.
- The body explains **why**, not what. Link the issue.
- One logical change per commit. Never mix a refactor with a behavior change — it makes
  review and `git bisect` useless.
- Never commit: secrets, `.env`, `node_modules`, build output, real customer data,
  commented-out code, or a `console.log`.

## Pull requests

Required in the description:
- What changed and why (link the issue/ADR).
- Screenshots or a clip for UI changes.
- Migration notes if the schema changed.
- **A security note** if the change touches auth, authorization, RLS, money movement, or
  PII: what threat was considered and how it is handled.
- Rollback plan for anything non-trivial.

Rules:
- Keep PRs under ~400 changed lines. Split large work into stacked PRs.
- CI green before review is requested — don't outsource `pnpm lint` to a human.
- At least one approval; **two** for changes to money calculations, authorization, or
  migrations.
- Author does not merge their own security-sensitive change.
- Review comments are about the code, and blocking objections are justified with a
  concrete failure scenario.

## Pre-commit hooks (Husky + lint-staged)

Format → lint → typecheck → secret scan (gitleaks) → related tests.
Hooks are fast (< 30 s) or people bypass them. Never commit with `--no-verify`.

## CI pipeline

1. Install with `--frozen-lockfile`
2. Lint + format check + typecheck
3. Architecture lint (`import/no-restricted-paths`) — the dependency rule is enforced here
4. Unit tests
5. Integration tests against a local Supabase
6. Migration check: migrations apply cleanly to a fresh DB **and** to a production-shaped copy
7. RLS isolation tests
8. `pnpm audit` + gitleaks
9. Build + bundle size budget
10. Smoke E2E

Any red step blocks the merge. Never merge on a "flaky, just re-run" without an issue.

## Releases & deploys

- Tag `main` with semver; release notes generated from Conventional Commits.
- Migrations deploy **before** the code that needs them; use expand → migrate → contract
  so the running version is never incompatible with the schema.
- A verified backup exists before any destructive migration.
- Deploy behind a feature flag when the change is risky; flags are removed once stable.
- Every deploy is annotated in dashboards, with a documented rollback path. If rollback
  requires a migration reversal, that reversal is written and tested **before** release.
- No deploys on Friday afternoons or during a customer's critical business window
  without an explicit, documented decision.
