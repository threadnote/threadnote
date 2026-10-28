# syntax=docker/dockerfile:1.7
FROM oven/bun:1.4.4-alpine AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts

FROM oven/bun:1.4.4-alpine AS runtime
WORKDIR /app
USER root
RUN apk add --no-cache git
ENV NODE_ENV=production
COPY --from=dependencies --chown=bun:bun /app/node_modules ./node_modules
COPY --chown=bun:bun package.json bun.lock ./
COPY --chown=bun:bun src ./src
USER bun
EXPOSE 8787
CMD ["bun", "apps/threadnote/src/standalone.ts", "remote-memory-service"]
