#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE="${ROOT}/deploy/compose.yaml"
DOCKERFILE="${ROOT}/deploy/Dockerfile"
PACKAGE="${ROOT}/package.json"
PLAYWRIGHT="${ROOT}/playwright.config.ts"

grep -Fq 'TEST_LOGIN_ENABLED: "false"' "${COMPOSE}"
grep -Fq 'NEXT_PUBLIC_TEST_LOGIN_ENABLED: "false"' "${COMPOSE}"
! grep -Fq '${TEST_LOGIN_ENABLED' "${COMPOSE}"
grep -Fxq 'ARG NEXT_PUBLIC_TEST_LOGIN_ENABLED=false' "${DOCKERFILE}"
grep -Fxq 'ENV NEXT_PUBLIC_TEST_LOGIN_ENABLED=${NEXT_PUBLIC_TEST_LOGIN_ENABLED}' "${DOCKERFILE}"
grep -Fq 'NEXT_PUBLIC_TEST_LOGIN_ENABLED=true' "${PACKAGE}"
grep -Fq 'TEST_LOGIN_ENABLED: "true"' "${PLAYWRIGHT}"
grep -Fq 'E2E_DEPLOYMENT_CLASS: "disposable"' "${PLAYWRIGHT}"

printf '%s\n' 'Direct test login is available only to the marked disposable E2E runtime.'
