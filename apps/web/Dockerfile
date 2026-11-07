# syntax=docker/dockerfile:1.7
#
# Build context is the REPOSITORY ROOT (pnpm workspace), not apps/web:
#   docker build -f apps/web/Dockerfile -t multitenant-base-web .
#
# Pin to a digest for production releases.

# ---------------------------------------------------------------- base
FROM node:22.23-alpine AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
RUN corepack enable
WORKDIR /app

# ---------------------------------------------------------------- deps
FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN corepack prepare --activate
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm fetch

# ---------------------------------------------------------------- build
FROM deps AS build
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --offline
# The API is served from the same origin (nginx proxies /api and /auth/v1 alongside the
# static bundle), so the client's fetch calls use relative paths and need no build-time
# API base URL.
RUN pnpm --filter @multitenant-base/web build

# ---------------------------------------------------------------- runtime
FROM nginx:1.27-alpine AS runtime
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
