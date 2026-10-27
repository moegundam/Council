#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE="${ROOT}/deploy/compose.yaml"
DOCKERFILE="${ROOT}/deploy/Dockerfile"
DEPLOY="${ROOT}/deploy/scripts/deploy-remote.sh"
FEATURE_FLAGS="${ROOT}/apps/web/src/lib/feature-flags.ts"
LOGIN_PAGE="${ROOT}/apps/web/src/app/login/page.tsx"
API="${ROOT}/apps/api/src/app.ts"

grep -Fq 'TAILNET_QUICK_LOGIN_ENABLED: ${TAILNET_QUICK_LOGIN_ENABLED' "$COMPOSE"
grep -Fq 'TAILNET_QUICK_LOGIN_IDENTITY: ${TAILNET_QUICK_LOGIN_IDENTITY' "$COMPOSE"
grep -Fq 'TAILNET_QUICK_LOGIN_OWNER_EMAIL: ${TAILNET_QUICK_LOGIN_OWNER_EMAIL' "$COMPOSE"
grep -Fq 'NEXT_PUBLIC_TAILNET_QUICK_LOGIN_ENABLED: ${TAILNET_QUICK_LOGIN_ENABLED' "$COMPOSE"
grep -Fxq 'ARG NEXT_PUBLIC_TAILNET_QUICK_LOGIN_ENABLED=false' "$DOCKERFILE"
grep -Fxq 'ENV NEXT_PUBLIC_TAILNET_QUICK_LOGIN_ENABLED=${NEXT_PUBLIC_TAILNET_QUICK_LOGIN_ENABLED}' "$DOCKERFILE"
grep -Fq 'TAILNET_QUICK_LOGIN_ENABLED' "$DEPLOY"
grep -Fq 'ALLOW_TAILNET_QUICK_LOGIN' "$DEPLOY"
grep -Fq 'NEXT_PUBLIC_TAILNET_QUICK_LOGIN_ENABLED' "$FEATURE_FLAGS"
grep -Fq '快速登入' "$LOGIN_PAGE"
grep -Fq 'request.headers["tailscale-user-login"]' "$API"
grep -Fq 'request.headers.origin === options.allowedOrigin' "$API"
grep -Fq 'TEST_LOGIN_ENABLED: "false"' "$COMPOSE"
grep -Fq 'AUTH_DISABLED: ${AUTH_DISABLED:?AUTH_DISABLED is required}' "$COMPOSE"

printf '%s\n' 'Tailnet quick-login rollout policy passed.'
