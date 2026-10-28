# syntax=docker/dockerfile:1.7
FROM --platform=linux/amd64 oven/bun:1.4.4-debian@sha256:b740c3f5600e6360684f240d31c67ffb759def968bfa98ed98c4cce970707735 AS build
WORKDIR /src
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts
COPY . .
ARG SOURCE_COMMIT
RUN test "${#SOURCE_COMMIT}" = 40 && \
    PACKAGE_VERSION="$(bun -p "require('./package.json').version")" && \
    THREADNOTE_DEVELOPMENT_BUILD_VERSION="${PACKAGE_VERSION}-local.g${SOURCE_COMMIT}" \
    THREADNOTE_BUILD_TARGET=bun-linux-x64-baseline bun run build && \
    bun build deploy/threadnote-org-graph/preflight.ts --target=bun --outfile=/tmp/graph-publisher-preflight.js

FROM --platform=linux/amd64 oven/bun:1.4.4-debian@sha256:b740c3f5600e6360684f240d31c67ffb759def968bfa98ed98c4cce970707735
USER root
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git openssh-client nginx-light tini && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/dist /opt/threadnote
COPY --from=build /tmp/graph-publisher-preflight.js /opt/threadnote/graph-publisher-preflight.js
COPY deploy/threadnote-org-graph/entrypoint.sh /usr/local/bin/threadnote-org-graph-entrypoint
COPY deploy/threadnote-org-graph/sync-checkout.sh /usr/local/bin/threadnote-org-graph-sync
COPY deploy/threadnote-org-graph/docker-credential-threadnote-oauth-publisher-m2m /usr/local/bin/docker-credential-threadnote-oauth-publisher-m2m
COPY deploy/threadnote-org-graph/nginx.conf /etc/threadnote/graph-nginx.conf
COPY deploy/threadnote-org/github_known_hosts /etc/threadnote/github_known_hosts
RUN chmod 755 /usr/local/bin/threadnote-org-graph-entrypoint /usr/local/bin/threadnote-org-graph-sync /usr/local/bin/docker-credential-threadnote-oauth-publisher-m2m && \
    chmod 644 /etc/threadnote/graph-nginx.conf /etc/threadnote/github_known_hosts && \
    mkdir -p /data /run/threadnote /run/nginx && \
    chown bun:bun /run/threadnote /run/nginx
ARG SOURCE_COMMIT
LABEL org.opencontainers.image.revision=$SOURCE_COMMIT
ENV PATH="/opt/threadnote:${PATH}" \
    THREADNOTE_HOME=/data/signed/threadnote \
    THREADNOTE_TELEMETRY=0
WORKDIR /data
USER bun
EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/threadnote-org-graph-entrypoint"]
