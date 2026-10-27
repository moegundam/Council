#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE="$ROOT/deploy/compose.yaml"

if rg -n --hidden \
  --glob '!**/public-selfhost-policy.test.sh' --glob '!.git/**' --glob '!node_modules/**' \
  --glob '!**/.next/**' --glob '!**/dist/**' --glob '!deploy/data/**' --glob '!deploy/secrets/**' \
  '/Users/fortune|/home/fortune|fortune@|100\.97\.248\.87|100\.104\.19\.82|100\.64\.0\.10|192\.168\.100\.100|tailb91254|macmini-docker' "$ROOT"; then
  echo "Public candidate contains a private host, user, address, or path." >&2
  exit 1
fi

model_tunnel_block="$(sed -n '/^  model-tunnel:/,/^  [a-zA-Z0-9_-]*:/p' "$COMPOSE")"
sandbox_block="$(sed -n '/^  sandbox-broker:/,/^  [a-zA-Z0-9_-]*:/p' "$COMPOSE")"
grep -Fq 'profiles: ["model-tunnel"]' <<<"$model_tunnel_block"
grep -Fq 'profiles: ["omp"]' <<<"$sandbox_block"
grep -Fq '127.0.0.1:${COUNCIL_PORT:-8787}:8080' "$COMPOSE"

grep -Fxq 'AUTH_DISABLED=false' "$ROOT/deploy/.env.example"
grep -Fxq 'ALLOW_PRODUCTION_AUTH_BYPASS=false' "$ROOT/deploy/.env.example"
grep -Fxq 'TAILNET_QUICK_LOGIN_ENABLED=false' "$ROOT/deploy/.env.example"
grep -Fxq 'OMP_RUNTIME_ENABLED=false' "$ROOT/deploy/.env.example"
grep -Fxq 'HARNESS_ACTION_ADAPTER_ENABLED=false' "$ROOT/deploy/.env.example"

for required in \
  LICENSE README.md CONTRIBUTING.md SECURITY.md CODE_OF_CONDUCT.md \
  docs/SELF_HOSTING.md docs/SUPPORT.md docs/OPEN_SOURCE_THREAT_MODEL.md \
  docs/THIRD_PARTY_NOTICES.md docs/ASSET_SOURCES.md docs/PROVENANCE.md; do
  test -s "$ROOT/$required" || { echo "Missing public release file: $required" >&2; exit 1; }
done
