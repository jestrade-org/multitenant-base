# Security — IAAA

**I**dentification · **A**uthentication · **A**uthorization · **A**ccounting.
Aligned with OWASP ASVS 4.0 and NIST SP 800-63B. This is a multi-tenant
business application: every one of these controls is mandatory, not aspirational.

---

## 1. Identification — who claims to be here

- Every principal has a **unique, non-reusable identity**. The canonical user ID is the
  `uuid` from `auth.users`. Never identify a user by email, tax id, national id, or name — those change
  and repeat.
- **No shared or generic accounts.** No `admin@empresa.cl` used by four people. Every
  human action must be attributable to one human.
- Machine identities (integrations, cron jobs, the API process itself) are distinct
  principals with their own credentials and their own minimal permissions. Never let a
  job run "as" a user.
- Identity is **never** taken from client input. It comes from the verified token only.
  A `userId` in a request body is data, not identity — reject it.
- Business identifiers (tax id, national id, employee number) are attributes, not
  credentials. Knowing someone's tax id grants nothing.
- User enumeration is prevented: signup, login, password reset, and invite flows return
  the same response and take the same time whether the account exists or not.

## 2. Authentication — prove the claim

**Provider:** Supabase Auth. Do not hand-roll authentication, password hashing, or
token issuance.

**Passwords** (NIST SP 800-63B):
- Minimum 12 characters; allow up to 64+, allow all Unicode including spaces.
- Check against a breached-password list (Supabase leaked-password protection **on**).
- **No forced periodic rotation.** Rotate only on evidence of compromise.
- No composition rules that push users to `Password1!`. No password hints. No security
  questions.
- Hashing is the provider's (bcrypt/argon2). Never store, log, or transmit a password
  anywhere else — including in an error message or an analytics event.

**MFA:**
- Required for any role that can move money, approve high-impact changes, or submit to an
  external authority. Required for all admins, including platform staff.
- TOTP or WebAuthn. SMS only as a fallback, never as the sole factor.
- Recovery codes are single-use, hashed at rest, and their use is an audited event.

**Sessions & tokens:**
- Verify the JWT server-side on **every** request: signature against the JWKS, plus
  `exp`, `nbf`, `aud`, `iss`. Never decode-without-verify.
- Short-lived access tokens (≤ 1 h). Refresh tokens rotate on use, with **reuse
  detection** that revokes the whole family.
- **Never store tokens in `localStorage` or `sessionStorage`** (XSS-readable). Use
  `httpOnly`, `Secure`, `SameSite=Lax|Strict` cookies, with CSRF protection
  (double-submit token or origin check) on state-changing requests.
- Session invalidation on logout, password change, MFA change, and role change must
  revoke server-side — not just clear the client.
- Absolute session lifetime plus idle timeout (30 min idle for sensitive views).

**Brute force & account recovery:**
- Progressive rate limiting and lockout on repeated failures, per account and per IP.
- Password reset tokens are random (≥128 bits), single-use, short-lived (≤ 30 min),
  and delivered out-of-band. Resetting a password revokes all sessions.
- Email change requires confirmation at both the old and new address.

**Step-up authentication:** re-authenticate (password or MFA) immediately before
high-risk operations: changing bank or identity-provider details, exporting a full data
set, changing another user's role, entering a company through support access.

## 3. Authorization — what the identity may do

**Deny by default.** Absence of an explicit grant is a denial, at every layer.

**Model:** RBAC scoped by tenant. Roles: `owner`, `accountant`, `analyst`, `viewer`,
plus per-company membership. Permissions are checked as capabilities
(`iam:user_manage`), not by comparing role strings scattered through the code.

**Where checks happen — all four layers:**
1. **UI** hides what the user cannot do. This is UX, *not* security.
2. **API route** authenticates and resolves the actor.
3. **Use case** performs the real authorization check before any state change. This is
   the authoritative decision point.
4. **RLS** in Postgres as defense in depth. Because the API uses `service_role` and
   bypasses RLS, layer 3 is never optional.

**Tenant isolation (the highest-risk failure in this product):**
- Every query is scoped by the `company_id` derived from the **token**, never from the
  request.
- Never look up a resource by ID alone: `findById(memberId, companyId)`.
- A resource belonging to another tenant returns **404**, not 403.
- Broken object-level authorization (IDOR) is the #1 API risk — every endpoint taking an
  ID needs a test proving cross-tenant access fails.

**Least privilege:**
- The `service_role` key lives only in the API process; nothing else may hold it.
- Database roles for jobs and reporting are read-only where possible.
- Third-party integrations get the narrowest scopes and are reviewed quarterly.
- No permission is granted "temporarily" without an expiry.

**Segregation of duties:** the user who creates a high-impact change cannot be its sole
approver. Enforce maker/checker in the domain for the flows a project marks as such (payment
runs, bulk changes, closing a period).

## 4. Accounting — record what happened

**Audit log** (`audit_events`), append-only, never updated or deleted:

| Field | Content |
|-------|---------|
| `occurred_at` | `timestamptz`, server clock |
| `actor_id`, `actor_type` | user or machine principal |
| `company_id` | tenant scope |
| `action` | English verb code: `tenant.suspended` |
| `resource_type`, `resource_id` | what was touched |
| `outcome` | `success` / `denied` / `error` |
| `ip`, `user_agent`, `correlation_id` | request context |
| `changes` | before/after for mutations (`jsonb`, PII-minimized) |

**Always audited:** login success and failure, logout, MFA enrolment and use, password
and email changes, role/permission grants and revocations, every authorization denial,
all money movement, tenant provisioning and suspension, plan changes, support access,
data exports, and any use of an administrative override.

**Rules:**
- Writing the audit event is part of the same transaction as the change. If the audit
  write fails, the operation fails.
- The application role has `insert` only — `revoke update, delete`. Tamper-evident.
- Clocks are synchronized (NTP); timestamps are server-side UTC, never client-supplied.
- Retention: as long as the strictest obligation of the projects built on this base (six
  years is a common statutory minimum for business records), with an
  export/archive path. Deletion requires a documented legal basis.
- **Never log:** passwords, tokens, session IDs, full card numbers, or complete
  business records. Log identifiers and reference the source of truth.
- PII in logs is minimized and, where unavoidable, masked (`taxId: 12-***-789`).
- Audit logs are readable by compliance roles through a dedicated, itself-audited view —
  not by direct table access.

## Verification checklist for any security-relevant PR

- [ ] Identity derived from the verified token only
- [ ] Authorization checked in the use case, not just the route or the UI
- [ ] Query scoped by `company_id` from the token
- [ ] RLS policy added/updated for touched tables, with an isolation test
- [ ] Audit event emitted in the same transaction
- [ ] No secret, token, or PII added to a log line
- [ ] Rate limiting considered for new public endpoints
- [ ] Step-up auth considered for high-risk actions
