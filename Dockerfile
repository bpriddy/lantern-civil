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

ENV CIVIL_WEB_ROOT=/app/apps/web/dist
ENV PORT=8080
EXPOSE 8080

USER node
CMD ["node", "apps/api/dist/main.js"]
