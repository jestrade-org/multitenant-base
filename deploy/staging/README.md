# Staging deployment

Staging only — ADR 0002 (`docs/adr/0002-staging-deployment.md`). **No real customer data
may exist on this server.** Every relaxation here is legitimate because of that sentence;
the moment real data lands on this box, the retention and backup obligations reattach and
this directory stops describing reality.

## What runs here

Postgres and GoTrue — nothing else from Supabase. The codebase has no
`@supabase/supabase-js` dependency, talks to Postgres directly through
`CONTROL_DATABASE_URL`, and uses Supabase only for Auth. Storage, Realtime, PostgREST and
Studio are never called, so they are not installed.

That reasoning is about what the code uses, not about what fits in the box. When a project
wires Storage, this topology changes and the decision is reopened.

## First-time setup

### 1. DNS

The tenant is resolved from the subdomain (`subdomainFromHost`), so the demo must be
reached at `<tenant>.<ROOT_DOMAIN>`. An IP address resolves to no tenant and every
tenant-scoped route fails. Two A records to the box:

    staging.example.test          A   <ip>
    acme.staging.example.test   A   <ip>

### 2. Secrets on the host

    sudo mkdir -p /etc/multitenant-base
    sudo install -m 600 -o deploy -g deploy /dev/null /etc/multitenant-base/staging.env

Fill it from `.env.staging.example`. Never commit the result.

The site has no nginx-level gate — anyone can reach it, and authenticates through the
app's own login. `limit_req` in `nginx/staging.conf` and the app's own auth are what
stand between an anonymous visitor and the box.

### 3. Certificates

Named hosts, HTTP-01, no DNS API token needed. The _first_ issuance happens before
nginx exists, so it serves the challenge itself — `--webroot` would have nothing to
write into:

    sudo mkdir -p /var/www/certbot
    sudo certbot certonly --standalone \
      -d staging.example.test -d acme.staging.example.test

Renewals run with nginx up, and use the webroot it already serves:

    sudo certbot renew --webroot -w /var/www/certbot

A demo that provisions tenants live needs `*.staging.example.test` instead, which requires
DNS-01 and a provider API token.

Renewal is monitored, not assumed — `check-certificate-expiry.sh` exits non-zero and must
be wired to something that pages a human.

### 4. The image

Built elsewhere and tagged with the git SHA. Building on the box works with 8 GB, but the
image does not have to be built where it runs:

    docker build -f apps/api/Dockerfile -t multitenant-base-api:$(git rev-parse --short HEAD) .

### 5. Bring it up

    docker compose -f deploy/staging/docker-compose.staging.yml \
      --env-file /etc/multitenant-base/staging.env up -d --wait

### 6. Schema

Migrations are pushed from outside — the Supabase CLI never gets installed on the server.
From a workstation, over a tunnel, because Postgres publishes no port:

    ssh -N -L 55432:127.0.0.1:5432 deploy@<host>
    pnpm supabase db push --db-url postgresql://postgres:<password>@127.0.0.1:55432/postgres

## Verify before believing it works

**JWT signing must be asymmetric.** `SupabaseAuth` verifies against the provider's
published keys and never holds a signing secret. GoTrue signs symmetrically by default,
and with that default login succeeds while every subsequent request fails verification —
a failure that looks like a network problem and is not:

    curl -s https://acme.staging.example.test/auth/v1/.well-known/jwks.json | jq '.keys[].alg'

`ES256` or `RS256`. Anything else, or an empty set, means `GOTRUE_JWT_KEYS` is wrong and
nothing else about the deploy is worth checking yet.

**Nothing but nginx listens publicly.** A published port bypasses ufw:

    sudo ss -tlnp | grep -v '127.0.0.1'

**Memory headroom.** The limits assume an 8 GB box:

    docker stats --no-stream --format 'table {{.Name}}\t{{.MemUsage}}\t{{.MemPerc}}'

An OOM kill is SIGKILL, so the app's SIGTERM drain never runs and an in-flight write is
cut. Containers that died this way are not obvious once they restart:

    docker inspect --format '{{.Name}} OOMKilled={{.State.OOMKilled}}' $(docker ps -aq)

## Rebuilding from scratch

There are no backups, by decision: the box is reproducible from migrations, `seed.sql`
and the demo fixtures. That reproduction _is_ the rehearsal. Anything on this server that
cannot be recreated that way should not have been on it.
