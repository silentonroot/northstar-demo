# syntax=docker/dockerfile:1

# Pinned to one Node release. Update the tag deliberately, not by floating.
# Base image pinned by tag and digest.

FROM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS deps
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# Production dependencies only; the lockfile is authoritative.
RUN corepack enable && pnpm install --frozen-lockfile --prod

FROM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS runtime
ENV NODE_ENV=production \
    NORTHSTAR_HOST=0.0.0.0 \
    NORTHSTAR_PORT=4100 \
    NORTHSTAR_DB_PATH=/data/northstar.sqlite
WORKDIR /app

# The database lives on a volume owned by the unprivileged "node" user. No secrets are baked in:
# the demo passwords are generated at seed time and printed to the terminal.
RUN mkdir /data && chown node:node /data
COPY --from=deps --chown=root:root /app/node_modules ./node_modules
COPY --chown=root:root package.json ./
COPY --chown=root:root server ./server
COPY --chown=root:root web ./web
COPY --chown=root:root database ./database
COPY --chown=root:root seed ./seed

USER node
VOLUME ["/data"]
EXPOSE 4100
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.NORTHSTAR_PORT||4100)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node_modules/.bin/tsx", "server/main.ts"]
