# syntax=docker/dockerfile:1
FROM node:22-alpine AS base
RUN corepack enable  # pnpm version comes from package.json#packageManager
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN pnpm exec tsc -p tsconfig.json --outDir dist --rootDir . --sourceMap false \
 && pnpm prune --prod --ignore-scripts

# Demo image (plan rev 4.15, M5 B4; fly.demo.toml builds this target): the runtime plus the
# committed replay and reference fixtures `pnpm demo` serves and loads. Declared before `runtime`
# so a plain `docker build` / `fly deploy` with fly.toml still builds the production image last.
FROM node:22-alpine AS demo
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist/src ./src
COPY package.json ./
COPY fixtures ./fixtures
USER node
CMD ["node", "src/bin/api.js"]

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist/src ./src
COPY package.json ./
USER node
# fly.toml selects the process: `node src/bin/worker.js` or `node src/bin/api.js`
CMD ["node", "src/bin/api.js"]
