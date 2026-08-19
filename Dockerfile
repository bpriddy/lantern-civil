# syntax=docker/dockerfile:1

# Built by Cloud Build, not locally — PRD 12 needs no local Docker, and the deploy
# path stays the same whether or not a laptop has it installed.

FROM node:24-slim AS build
WORKDIR /app

# Manifests first so the dependency layer caches independently of source changes.
COPY package.json package-lock.json ./
COPY packages/schema/package.json packages/schema/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci

COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps

RUN npm run build --workspace @civil/schema \
 && npm run build --workspace @civil/api \
 && npm run build --workspace @civil/web

FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# PRD 7.2's contract discovery reads Python with Python's own ast module, because at
# M4 the runtime binds arguments to these same functions and one implementation of
# "what is this function's contract" is the point. civil_runtime.discover is
# stdlib-only, so this needs an interpreter and nothing else — no pip, no venv.
#
# python3, not python3-minimal: Debian's minimal package is the interpreter without
# the full standard library, and it omits `json` — which discover.py needs to answer
# at all. The boot probe caught this in production; nothing else would have, because
# discovery degrades silently by design.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY packages/schema/package.json packages/schema/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/packages/schema/dist packages/schema/dist
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/web/dist apps/web/dist
# Migrations ship with the image so the migrate job and the service are always the
# same version — a job running older SQL than the code it precedes is a bad night.
COPY apps/api/migrations apps/api/migrations
# Quickstarts, opened from the empty state. Immutable and shipped with the code, so
# reading them from the image does not make the container the only copy of anything.
COPY examples ./examples
COPY runtime/src ./runtime/src

ENV CIVIL_WEB_ROOT=/app/apps/web/dist
ENV PORT=8080
EXPOSE 8080

USER node
CMD ["node", "apps/api/dist/main.js"]
