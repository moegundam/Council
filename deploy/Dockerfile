ARG NODE_IMAGE=node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8
ARG WORKER_NODE_IMAGE=node:24.14.0-trixie-slim@sha256:8c8f12cedb96c3b59642cf30d713943c2b223990c9919b96a141681f62e6e292
ARG DOCKER_CLI_IMAGE=docker:29.7.2-cli@sha256:eb952fbf036947347bff9f303878c86ec3df00af0341f4cca59b1d1924d6668d

FROM ${DOCKER_CLI_IMAGE} AS docker-cli

FROM ${NODE_IMAGE} AS builder

ARG NEXT_PUBLIC_GOAL_RUN_AUTONOMY_ENABLED=false
ARG NEXT_PUBLIC_TEST_LOGIN_ENABLED=false
ARG NEXT_PUBLIC_TAILNET_QUICK_LOGIN_ENABLED=false
ARG NEXT_PUBLIC_OMP_RUNTIME_ENABLED=false
ARG NEXT_PUBLIC_SOURCE_URL=
ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}
ENV NEXT_TELEMETRY_DISABLED=1
ENV NEXT_PUBLIC_GOAL_RUN_AUTONOMY_ENABLED=${NEXT_PUBLIC_GOAL_RUN_AUTONOMY_ENABLED}
ENV NEXT_PUBLIC_TEST_LOGIN_ENABLED=${NEXT_PUBLIC_TEST_LOGIN_ENABLED}
ENV NEXT_PUBLIC_TAILNET_QUICK_LOGIN_ENABLED=${NEXT_PUBLIC_TAILNET_QUICK_LOGIN_ENABLED}
ENV NEXT_PUBLIC_OMP_RUNTIME_ENABLED=${NEXT_PUBLIC_OMP_RUNTIME_ENABLED}
ENV NEXT_PUBLIC_SOURCE_URL=${NEXT_PUBLIC_SOURCE_URL}
WORKDIR /workspace

RUN corepack enable && corepack prepare pnpm@11.7.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json vitest.config.ts ./
COPY apps/api/package.json apps/api/package.json
COPY apps/mcp-readonly/package.json apps/mcp-readonly/package.json
COPY apps/model-tunnel/package.json apps/model-tunnel/package.json
COPY apps/sandbox-broker/package.json apps/sandbox-broker/package.json
COPY apps/task-adapter-reference/package.json apps/task-adapter-reference/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/runtime/package.json packages/runtime/package.json

RUN pnpm install --frozen-lockfile

COPY apps ./apps
COPY packages ./packages

RUN pnpm build \
  && pnpm --filter @council/api deploy --prod --legacy /out/api \
  && pnpm --filter @council/mcp-readonly deploy --prod --legacy /out/mcp-readonly \
  && pnpm --filter @council/model-tunnel deploy --prod --legacy /out/model-tunnel \
  && pnpm --filter @council/sandbox-broker deploy --prod --legacy /out/sandbox-broker \
  && pnpm --filter @council/task-adapter-reference deploy --prod --legacy /out/task-adapter-reference \
  && pnpm --filter @council/worker deploy --prod --legacy /out/worker

FROM ${NODE_IMAGE} AS api

ENV NODE_ENV=production
ENV PORT=4000
WORKDIR /app

RUN groupadd --system --gid 10001 council \
  && useradd --system --uid 10001 --gid council --home-dir /app council

COPY --from=builder --chown=council:council /out/api ./
RUN chmod -R a+rX /app

USER council
EXPOSE 4000
CMD ["node", "dist/server.js"]

FROM ${WORKER_NODE_IMAGE} AS worker

ENV NODE_ENV=production
WORKDIR /app

RUN npm install --global @openai/codex@0.146.0 \
  && npm cache clean --force \
  && groupadd --system --gid 10001 council \
  && useradd --system --uid 10001 --gid council --home-dir /app council

COPY --from=builder --chown=council:council /out/worker ./
COPY --chown=root:root deploy/governance /etc/council/governance
RUN chmod -R a+rX /app /etc/council/governance \
  && chmod -R a-w /etc/council/governance

USER council
CMD ["node", "dist/server.js"]

FROM ${NODE_IMAGE} AS mcp-readonly

ENV NODE_ENV=production
ENV PORT=4100
WORKDIR /app

RUN groupadd --system --gid 10001 council \
  && useradd --system --uid 10001 --gid council --home-dir /app council

COPY --from=builder --chown=council:council /out/mcp-readonly ./
RUN chmod -R a+rX /app

USER council
EXPOSE 4100
CMD ["node", "dist/server.js"]

FROM ${NODE_IMAGE} AS model-tunnel

ENV NODE_ENV=production
ENV LOCAL_PORT=4001
ENV HEALTH_PORT=4101
WORKDIR /app

RUN apt-get -o Acquire::http::Timeout=10 -o Acquire::Retries=2 update \
  && apt-get install -y --no-install-recommends openssh-client=1:9.2p1-2+deb12u10 \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system --gid 10001 council \
  && useradd --system --uid 10001 --gid council --home-dir /app council

COPY --from=builder --chown=council:council /out/model-tunnel ./
RUN chmod -R a+rX /app

USER council
EXPOSE 4001 4101
CMD ["node", "dist/server.js"]

FROM ${NODE_IMAGE} AS sandbox-broker

ENV NODE_ENV=production
ENV SANDBOX_BROKER_BIND_HOST=0.0.0.0
ENV SANDBOX_BROKER_PORT=8080
WORKDIR /app

RUN groupadd --system --gid 10001 council \
  && useradd --system --uid 10001 --gid council --home-dir /app council

COPY --from=docker-cli --chown=root:root /usr/local/bin/docker /usr/local/bin/docker
COPY --from=builder --chown=council:council /out/sandbox-broker ./
RUN chmod 0555 /usr/local/bin/docker \
  && chmod -R a+rX /app \
  && docker --version

USER council
EXPOSE 8080
CMD ["node", "dist/main.js"]

FROM ${NODE_IMAGE} AS task-adapter-reference

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4200
WORKDIR /app

RUN groupadd --system --gid 10001 council \
  && useradd --system --uid 10001 --gid council --home-dir /app council

COPY --from=builder --chown=council:council /out/task-adapter-reference ./
RUN chmod -R a+rX /app

USER council
EXPOSE 4200
CMD ["node", "dist/server.js"]

FROM ${NODE_IMAGE} AS web

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

RUN groupadd --system --gid 10001 council \
  && useradd --system --uid 10001 --gid council --home-dir /app council

COPY --from=builder --chown=council:council /workspace/apps/web/.next/standalone ./
COPY --from=builder --chown=council:council /workspace/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=council:council /workspace/apps/web/public ./apps/web/public

USER council
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
