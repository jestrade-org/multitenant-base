# Docker — Local Development

Scope: local development and CI. **Production deployment is not decided yet** — see the
last section. Do not add deployment infrastructure to this repo until it is.

## What runs in Docker, and what does not

| Component | In Docker? | Why |
|---|---|---|
| Supabase stack | **Yes** — by the CLI | `supabase start` *is* Docker. Not optional. |
| `apps/api` (`pnpm dev`) | **No** | Native. Faster restarts, debugger attaches directly. |
| `apps/web` (`pnpm dev`) | **No** | Native. Docker bind mounts break Vite HMR on macOS. |

**Never dockerize the development loop.** The local setup is:

```bash
supabase start     # Postgres, Auth, Storage, Realtime, Studio — ~10 containers
pnpm dev           # API and web, native, pointing at 127.0.0.1:55321
```

Putting the dev servers in a `docker-compose` costs broken HMR, dependency reinstalls on
every lockfile change, awkward debugger attachment, and RAM on top of the Supabase
containers. It buys nothing that `pnpm dev` does not already give.

## Installing the Supabase CLI

The CLI and the stack are different layers. **The CLI is never installed via Docker** —
it is the tool that drives Docker.

- **Pin it as a workspace devDependency**, not globally:
  ```bash
  pnpm add -D -w supabase
  ```
  Invoke it as `pnpm supabase <command>` or through a package script.
- Rationale: CLI versions differ in generated output and migration handling. A developer
  on one version and CI on another produces phantom diffs in `database.types.ts` and
  migrations that apply differently in each environment. Pinning the CLI is the same
  reproducibility rule as `--frozen-lockfile`.
- **Global npm installation is not supported** by Supabase. Valid alternatives are
  Homebrew (`brew install supabase/tap/supabase`) or the released binary — acceptable for
  a first local setup, before the workspace exists.
- Do not keep a Homebrew CLI and a workspace CLI at the same time. Two versions on the
  `PATH` is exactly the drift this rule prevents.
- CI installs the same pinned version from the lockfile. Never `latest` on a runner.

## Supabase local stack

- `supabase start` / `supabase stop`. Stop it when you are not using it — the stack uses
  roughly 3–4 GB of RAM.
- Configuration lives in `supabase/config.toml`, committed. Never configure the local
  stack by clicking in Studio.
- **This base has its own Supabase instance.** `project_id = "multitenant-base"` gives it
  its own containers and volumes, and its ports are shifted from the CLI defaults
  (`543xx`) to `553xx`, so it runs beside another project's stack (Virtual CFO, or the
  next project forked from this base) without colliding. A project forked from the base
  picks its own `project_id` and port range the same way.
- Local endpoints: API `http://127.0.0.1:55321`, Postgres `:55322`, Studio `:55323`,
  Inbucket (email capture) `:55324`. The dev servers use API `:3100` and web `:5273`.
- `supabase db reset` re-applies every migration from scratch and runs `seed.sql`. Run it
  before opening a PR that touches the schema — it is the same thing CI does.
- **All development and tests run against the local stack.** Never point a local
  environment at production or at a shared staging database
  (`@.claude/rules/supabase.md`).
- Seed data uses synthetic fixtures and **never real customer data**.

## Host requirements

- Docker Desktop, OrbStack, or Colima. On macOS, **OrbStack** starts faster, uses
  noticeably less memory, and handles bind mounts better than Docker Desktop.
- Docker Desktop requires a paid subscription above 250 employees or USD 10M revenue.
  If this becomes a company product, verify the license or move to OrbStack/Colima.
- Allocate at least 6 GB to the Docker VM. Below that, the Supabase stack and a test run
  will contend.

## CI

- Integration and RLS tests run against a Supabase stack started by the CLI on the
  runner (`ubuntu-latest` ships with Docker).
- CI verifies migrations apply cleanly to a **fresh** database, not to an incrementally
  migrated one.
- Never let CI touch a hosted project. Ephemeral local stack only.

## API image (`apps/api/Dockerfile`)

The image exists so builds are reproducible and CI can verify one. It is **not** wired to
any deployment yet.

- **Multi-stage**: `deps` → `build` → `runtime`. The runtime stage carries no source, no
  devDependencies, no build toolchain.
- **Build context is the repository root** (pnpm workspace), so `.dockerignore` lives at
  the root: `docker build -f apps/api/Dockerfile .`
- Base image pinned to a minor version (`node:22.23-alpine`); pin to a digest once
  releases are real. Never `latest`.
- `pnpm install --frozen-lockfile`. A build that mutates the lockfile fails.
- **Runs as non-root** (`USER node`), with a `HEALTHCHECK` against `/health/ready`.
- **No secrets in the image.** No `ARG` carrying a token, no `.env` copied in, no
  `service_role` key at build time — build args are recorded in the image history.
- Tag with the git SHA, never only `latest`.

## Production — not decided

Staging is decided in ADR 0002 (`docs/adr/0002-staging-deployment.md`); production is not.

The deployment target is a self-managed VPS, but the reverse proxy and TLS strategy are
**open decisions**. Nothing in this repo should assume one.

Before adding deployment files, decide and record in an ADR:
- reverse proxy and TLS termination (nginx, Traefik, a tunnel, or a managed edge);
- whether Supabase stays hosted — the default, given audit retention obligations
  (`@.claude/rules/security-iaaa.md`) — or is self-hosted;
- who owns backups, and when restores are rehearsed.

Two constraints that will apply regardless of the proxy chosen:
- **The API must never publish a port to the host.** Docker's port publishing bypasses
  ufw/nftables rules, exposing the service directly to the internet. It is reachable only
  through the proxy on an internal network.
- **Secrets are never in the compose file, the image, or git** — a file on the host, mode
  600, owned by the deploy user.
