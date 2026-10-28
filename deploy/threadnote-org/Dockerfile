# syntax=docker/dockerfile:1.7
FROM oven/bun:1.4.4-alpine AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts

FROM oven/bun:1.4.4-alpine AS runtime
WORKDIR /app
USER root
RUN apk add --no-cache ca-certificates git openssh-client su-exec
ENV NODE_ENV=production
ARG THREADNOTE_SOURCE_REVISION=unknown
LABEL org.opencontainers.image.revision=$THREADNOTE_SOURCE_REVISION
COPY --from=dependencies --chown=bun:bun /app/node_modules ./node_modules
COPY --chown=bun:bun package.json bun.lock ./
COPY --chown=bun:bun src ./src
COPY deploy/threadnote-org/entrypoint.sh /usr/local/bin/threadnote-org-entrypoint
COPY deploy/threadnote-org/github_known_hosts /etc/threadnote/github_known_hosts
RUN chmod 755 /usr/local/bin/threadnote-org-entrypoint && chmod 644 /etc/threadnote/github_known_hosts
EXPOSE 8787
ENTRYPOINT ["/usr/local/bin/threadnote-org-entrypoint"]
CMD ["bun", "apps/threadnote/src/standalone.ts", "remote-memory-service"]
