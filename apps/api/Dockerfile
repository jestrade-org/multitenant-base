# syntax=docker/dockerfile:1.7
#
# Build context is the REPOSITORY ROOT (pnpm workspace), not apps/api:
#   docker build -f apps/api/Dockerfile -t multitenant-base-api .
#
# Pin to a digest for production releases:
#   FROM node:22.23-alpine@sha256:<digest> AS base

# ---------------------------------------------------------------- base
FROM node:22.23-alpine AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
RUN corepack enable
WORKDIR /app

# ---------------------------------------------------------------- deps
# Fetch dependencies into the pnpm store using only the lockfile, so this
# layer is reused on every build that does not change dependencies.
FROM base AS deps
# `package.json` travels with the lockfile because corepack reads the pinned pnpm version
# from its `packageManager` field. Without it corepack resolves "latest" instead, which
# both breaks the build and silently defeats the version pinning docker.md requires.
COPY package.json pnpm-lock.yaml ./
RUN corepack prepare --activate
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm fetch

# ---------------------------------------------------------------- build
FROM deps AS build
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --offline
# `tsc --build apps/api` walks the project references and compiles every workspace
# package the API depends on, in order. Filtering to the API alone compiled nothing else,
# so the build only ever worked on a machine where the packages' `dist/` already existed
# from a previous run — which is to say, never in a clean image.
RUN pnpm exec tsc --build apps/api
# `deploy` produces a self-contained tree with the app plus its workspace
# dependencies and production node_modules only.
# --legacy is required while the workspace does not use injected dependencies.
RUN pnpm --filter @multitenant-base/api deploy --legacy --prod /out

# ---------------------------------------------------------------- runtime
FROM base AS runtime
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app

# No source, no devDependencies, no build toolchain in this stage.
COPY --from=build --chown=node:node /out ./

# Tenant provisioning applies these at runtime, so they belong to the artefact rather
# than to the build. `pnpm deploy` does not carry them — they are not a workspace
# package — and the process validates the directory at startup, so without this the
# container refuses to boot rather than failing later.
COPY --from=build --chown=node:node /app/supabase/tenant-migrations ./supabase/tenant-migrations

# Delivered documents land here, on a volume. Created before the mount and owned by
# `node`, or the unprivileged user cannot write to it.
RUN mkdir -p /data/storage && chown -R node:node /data

# Drop privileges. Never run the API as root on a shared host.
USER node
EXPOSE 3000

# Compose gates the deploy on this: `docker compose up -d --wait`.
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# The app installs its own SIGTERM handler and drains in-flight requests;
# Compose runs it under `init: true` for zombie reaping.
CMD ["node", "dist/main.js"]
