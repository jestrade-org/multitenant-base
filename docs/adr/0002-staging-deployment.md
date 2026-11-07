# ADR 0002 — Deploying the staging environment

- **Status:** accepted
- **Date:** 2026-09-14 (carried over from Virtual CFO; revised 2026-11-07)
- **Deciders:** Jesús Estrada
- **Resolves:** the open decisions recorded in `.claude/rules/docker.md` §Production,
  for the staging environment only
- **Related:** ADR 0001

## Context

`.claude/rules/docker.md` left three things undecided and forbade adding deployment
files until they were settled: the reverse proxy and TLS strategy, whether Supabase
stays hosted or is self-hosted, and who owns backups. Nothing could be deployed
anywhere while those were open.

A staging box is wanted: a VPS, to demonstrate the product and to exercise the whole
stack outside a developer's laptop. That is a narrower problem than the one
`docker.md` was worrying about, and it can be decided on its own terms.

## Decision

**This ADR covers the staging environment and nothing else.** Production remains
undecided. A later ADR may reach different conclusions on all three points, and
nothing here should be read as a precedent for it.

### Synthetic data only

This is the constraint the other three rest on.

**No real customer data may exist on this server.** Not a company name, not a person,
not a record. The fixtures are the ones the suite already uses: the synthetic companies in
`supabase/seed.sql` and the demo users created by `pnpm seed:auth`.

Every relaxation below is legitimate _because_ of that sentence. The moment real
customer data lands on this box, the obligations reattach — audit retention, a backup
owner, a rehearsed restore — and this ADR stops describing
reality. Putting real data here is not a deployment decision; it is a decision to
operate production, and it needs its own ADR.

### Supabase: self-hosted on the VPS

`docker.md` names hosted Supabase the default, and the reason it gives is the audit
retention obligation. That obligation does not apply to synthetic data, so the reason
does not apply here.

Self-hosting on the same box keeps the environment closed and costs nothing per month,
which for a demo is the whole point. It also exercises the self-hosted path a customer
who refuses data egress would need, rather than leaving it theoretical.

The cost is roughly ten containers and their memory. If the box cannot carry the
Supabase stack plus the API, the answer is a bigger box or hosted Supabase — not
trimming the stack until it fits, which produces an environment that no longer
resembles anything.

### Reverse proxy: nginx, TLS by certbot

nginx terminates TLS and is the only thing listening on the public interface.
Certificates come from Let's Encrypt via certbot, renewed on a timer.

certbot's renewal is a separate moving part that fails silently — that is the known
cost of this choice over Caddy. It is therefore monitored: a check on the certificate's
remaining lifetime that alerts before expiry, not a cron job nobody reads.

### Backups: none, and that is the decision

`docker.md` asks who owns backups and when restores are rehearsed. For this
environment the honest answer is that **there are no backups, because there is nothing
worth backing up.** The box is reproducible from the repository: migrations plus
`seed.sql` plus `pnpm seed:auth`.

The rehearsal, then, is the rebuild itself — provisioning has to be able to recreate
the environment from scratch, and that is exercised by doing it rather than by
restoring a dump. Anything on this server that cannot be recreated that way is
something that should not have been on it.

### Constraints that survive from `docker.md`

Both apply here exactly as written, and neither is relaxed by this being staging:

- **The API never publishes a port to the host.** Docker's port publishing bypasses
  ufw, so a published port is on the internet regardless of the firewall. The API is
  reachable only from nginx over an internal Docker network.
- **Secrets are never in the compose file, the image, or git.** They live in a file on
  the host, mode 600, owned by the deploy user.

## Consequences

- Deployment files may be added to the repository, scoped to staging and named as such.
  A file that is not obviously staging-only invites being copied to production.
- The API image runs Node 22 (`node:22.23-alpine`): the dependency tree cannot run on
  Node 20, which reached end of life in April 2026. CI builds the image and checks that it
  answers `/health/ready`.
- `.dockerignore` excludes `**/*.tsbuildinfo` and `**/dist`: Docker's ignore patterns are
  not recursive, and a stale build-info file written on a case-insensitive filesystem makes
  `tsc --build` skip emitting declarations inside the Linux image.
- The image is built with `tsc --build apps/api`, which walks the project references and
  compiles the workspace packages the API depends on.
- Password authentication over SSH is disabled once key access is confirmed. A staging
  box on a public IP is a target like any other.

## Alternatives considered

**Hosted Supabase for staging too.** Closer to a future production, and it costs money
every month for an environment whose data is disposable. Revisit when production is
decided — at that point matching the two environments starts to matter more than the
bill.

**Caddy instead of nginx.** Fewer places to get TLS wrong, and it was the
recommendation. nginx was chosen deliberately; the renewal monitoring above is the
mitigation for what Caddy would have handled by default.

**Deploying the development loop with docker compose.** Rejected by `docker.md` and
not revisited: this is a deployed environment, not a dev loop, and the two do not share
a compose file.

## Resolved since acceptance

1. **The box carries it.** The topology is Postgres plus GoTrue and nothing else from
   Supabase — not because the full stack would not fit, but because the codebase never
   calls Storage, Realtime, PostgREST or Studio. When a project wires Storage, this
   decision is reopened rather than stretched. Memory is bounded per container
   (`deploy/staging/docker-compose.staging.yml`); an OOM kill is SIGKILL, so the API's
   SIGTERM drain would not run.

2. **The hostname is `staging.example.test`, with the demo tenant at
   `acme.staging.example.test`** — placeholders a project replaces with its own domain.
   Reaching the box by bare IP is not possible: `subdomainFromHost` resolves the tenant
   from the Host header and returns `undefined` for an IP, so every tenant-scoped route
   answers `tenantNotResolved()`. Session cookies are `Secure` under
   `NODE_ENV=production` and a browser discards them over plain HTTP.

   Certificates are issued for named hosts over HTTP-01, which needs no DNS API token.
   A demo that provisions tenants live would need `*.staging.example.test`, and wildcard
   means DNS-01.

3. **The demo is public, behind the application's own login and nginx rate limits.**
   Every action inside is attributed through the application's own sign-in.

## Open questions

1. `.nvmrc`, `engines`, `CLAUDE.md` and `docker.md` still name Node 20 while the image runs
   Node 22. Reconciling them is a decision for whoever owns the support policy.
