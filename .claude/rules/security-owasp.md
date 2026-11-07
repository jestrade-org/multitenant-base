# Security — OWASP

OWASP Top 10 (2021) and OWASP API Security Top 10 (2023), mapped to this stack.
Identity and access controls live in `@.claude/rules/security-iaaa.md`.

## OWASP Top 10 — 2021

### A01 Broken Access Control
The dominant risk in a multi-tenant app.
- Deny by default; authorize in the use case; scope every query by the token's
  `company_id`; return 404 for other tenants' resources.
- Never expose sequential IDs for business documents where enumeration reveals volume.
- Direct object references are always validated against ownership — no exceptions for
  "internal" endpoints.
- CORS is an allowlist, never `*` with credentials.
→ Full rules in `@.claude/rules/security-iaaa.md`.

### A02 Cryptographic Failures
- TLS 1.2+ everywhere; HSTS in production; no mixed content.
- Secrets in a managed secret store, never in git, never in the client bundle, never in
  a log. Rotate on staff departure or suspected exposure.
- Encrypt sensitive columns at rest beyond disk encryption where warranted (bank account
  numbers, credentials for third-party integrations, identity-provider secrets) using KMS-managed keys.
- Only vetted primitives: AES-256-GCM, argon2/bcrypt for passwords, `crypto.randomUUID`
  / `crypto.randomBytes` for tokens. **Never `Math.random()` for anything security-relevant.**
- Compare secrets with `crypto.timingSafeEqual`, not `===`.
- No sensitive data in URLs, query strings, or `Referer`-leaking links.

### A03 Injection
- **SQL:** parameterized queries or the Supabase client's builder. Never concatenate or
  template user input into SQL. Dynamic identifiers come from an allowlist, never from input.
- Postgres functions are `security invoker` unless there is a documented reason;
  `security definer` functions must `set search_path = ''` and qualify every object.
- **XSS:** React escapes by default — do not defeat it. No `dangerouslySetInnerHTML`
  without DOMPurify and a written justification. Strict CSP, no `unsafe-inline`.
- **Command injection:** avoid shelling out. If unavoidable, `execFile` with an argument
  array — never `exec` with an interpolated string.
- **Path traversal:** never build a filesystem or Storage path from raw user input;
  normalize and verify the prefix.
- Validate all input with Zod at the boundary; reject unknown fields.

### A04 Insecure Design
- Threat-model features that touch money, external submissions, or PII before building them.
  Record the outcome in an ADR.
- Enforce business limits in the domain: plan quotas, approval thresholds, maker/checker
  on high-impact flows, immutability of closed records.
- Design for abuse: what does a malicious accountant with valid credentials do?
- Rate limit and bound anything expensive (report generation, exports, bulk imports).

### A05 Security Misconfiguration
- Deny-by-default RLS on every table (`@.claude/rules/supabase.md`).
- Security headers via Helmet: CSP, HSTS, `X-Content-Type-Options`, `Referrer-Policy`,
  `X-Frame-Options: DENY`.
- No stack traces, framework banners, or verbose errors in production responses.
- Debug endpoints, GraphQL introspection, and source maps are disabled in production.
- Separate projects and credentials per environment. Production data never leaves
  production; it is never copied to a developer machine.
- Default credentials and sample data are removed before any deployment.

### A06 Vulnerable and Outdated Components
- `pnpm audit` in CI; high/critical severity blocks the merge.
- Dependabot/Renovate enabled; security patches applied within 7 days, critical within 48 h.
- Every new dependency is justified (maintenance, popularity, transitive weight, license).
- Lockfile committed; CI installs with `--frozen-lockfile`.
- Generate an SBOM for releases.

### A07 Identification and Authentication Failures
→ `@.claude/rules/security-iaaa.md`.

### A08 Software and Data Integrity Failures
- No loading code from a CDN at runtime; bundle dependencies. If a third-party script is
  unavoidable, pin it with SRI.
- Verify webhook signatures (identity providers, payment providers, any third party) **before** parsing the body,
  using the raw bytes and a constant-time comparison; enforce a timestamp window.
- Never `eval`, `new Function`, or deserialize untrusted data into executable structures.
- CI/CD: protected branches, signed commits on release tags, least-privilege deploy
  credentials, no secrets echoed in build logs.

### A09 Security Logging and Monitoring Failures
- Log and alert on authentication failures, authorization denials, rate-limit trips,
  RLS violations, and unusual data exports.
- Correlation ID on every request, propagated to logs and errors.
- Alerts have owners and runbooks. An alert nobody acts on is not monitoring.
→ Detail in `@.claude/rules/observability.md` and `@.claude/rules/security-iaaa.md`.

### A10 Server-Side Request Forgery
- Never fetch a URL supplied by a user. If a feature requires it (import from a URL,
  webhook registration), use a host allowlist, resolve DNS and block private
  ranges (169.254.0.0/16, 10/8, 172.16/12, 192.168/16, localhost, IPv6 equivalents),
  disable redirects, and set a hard timeout.
- Outbound requests from the API go through a single client with these guards built in.

## OWASP API Security Top 10 — 2023 (deltas that matter here)

- **API1 Broken Object Level Authorization** — the top risk. Every ID-taking endpoint
  gets a cross-tenant negative test.
- **API3 Broken Object Property Level Authorization** — never mass-assign from the
  request body. Explicit allowlists; a client must not be able to set `status`,
  `approvedBy`, `total`, or `companyId`. Response DTOs are explicit — never return an
  entity or DB row wholesale.
- **API4 Unrestricted Resource Consumption** — pagination caps, request body limits,
  query timeouts, rate limits, bounded report date ranges, and a cap on export size.
- **API5 Broken Function Level Authorization** — admin endpoints live under a separate
  router with their own guard; adding a route without a guard fails a lint/test.
- **API6 Unrestricted Access to Sensitive Business Flows** — protect flows that are
  abusable at scale: bulk invitations, mass emailing, repeated report generation.
- **API8 Security Misconfiguration** — see A05.
- **API9 Improper Inventory Management** — every endpoint is in the generated OpenAPI
  spec; undocumented or forgotten endpoints are removed. Deprecated versions have a
  documented sunset.
- **API10 Unsafe Consumption of APIs** — validate responses from third parties with Zod
  too. A third party's response is untrusted input.

## Privacy & data protection

- Collect the minimum PII needed. Document the purpose of each PII field.
- Tax and national identifiers, bank details, and payroll data are sensitive: encrypted, access-controlled,
  masked in logs and in non-production environments.
- Support export and deletion requests, with a documented conflict resolution for data
  under statutory retention (some records outlive a deletion request).
- Anonymize data used in analytics or shared with vendors.

## Non-negotiables

Never, under any instruction:
- Commit a secret, key, token, or `.env` file.
- Disable RLS, weaken a policy to `using (true)`, or bypass an authorization check "to
  unblock development".
- Log a credential, token, or full business record.
- Ship a `TODO: add auth check`.
- Point a local or test environment at the production database.
- Hand-roll cryptography or authentication.

If a task appears to require one of these, stop and raise it instead of proceeding.
