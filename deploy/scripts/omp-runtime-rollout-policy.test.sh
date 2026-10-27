#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEPLOY="${ROOT}/deploy/scripts/deploy-remote.sh"
COMPOSE="${ROOT}/deploy/compose.yaml"
ENV_EXAMPLE="${ROOT}/deploy/.env.example"
RUNTIME_DOCKERFILE="${ROOT}/deploy/omp-runtime.Dockerfile"
WORKSPACE_INITIALIZER="${ROOT}/deploy/omp-runtime/init-workspace.mjs"
RUNTIME_ENTRYPOINT="${ROOT}/deploy/omp-runtime/run-omp.sh"
TEMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEMP_ROOT"' EXIT

for flag in OMP_RUNTIME_ENABLED OMP_HOST_TOOLS_ENABLED OMP_SUBAGENTS_ENABLED; do
  grep -Fq "${flag}: \${${flag}:-false}" "$COMPOSE"
  grep -Fqx "${flag}=false" "$ENV_EXAMPLE"
done
grep -Fq 'ALLOW_OMP_RUNTIME="${ALLOW_OMP_RUNTIME:-false}"' "$DEPLOY"
grep -Fq 'ALLOW_OMP_HOST_TOOLS="${ALLOW_OMP_HOST_TOOLS:-false}"' "$DEPLOY"
grep -Fq 'ALLOW_OMP_SUBAGENTS="${ALLOW_OMP_SUBAGENTS:-false}"' "$DEPLOY"
grep -Fq 'OMP Host Tools are not available in the phase-one release.' "$DEPLOY"
grep -Fq 'OMP subagents are not available in the phase-one release.' "$DEPLOY"
grep -Fq 'chown omp:omp /council-config /workspace' "$RUNTIME_DOCKERFILE"
grep -Fq 'ARG OMP_NATIVE_BASELINE_SHA256=cb35f7aa87353e1d603b39636236ef31fe8f776af231ec319a981e6a69d812f4' "$RUNTIME_DOCKERFILE"
grep -Fq '/usr/local/bin/pi_natives.linux-x64-baseline.node' "$RUNTIME_DOCKERFILE"
grep -Fq 'approved_agent_dir=/opt/council-omp-config' "$RUNTIME_ENTRYPOINT"
grep -Fq 'pi_natives.linux-x64-baseline.node' "$RUNTIME_ENTRYPOINT"
grep -Fq 'archive !== "/council-config/.council-source.tar"' "$WORKSPACE_INITIALIZER"
if grep -Fq 'run("chown"' "$WORKSPACE_INITIALIZER"; then
  printf '%s\n' 'OMP workspace initializer must not require a retained CHOWN capability' >&2
  exit 1
fi
if grep -Fq 'join(workspace, ".omp", "sessions")' "$WORKSPACE_INITIALIZER"; then
  printf '%s\n' 'OMP provider Session state must not be written into the reviewable source workspace' >&2
  exit 1
fi

dummy_bundle="${TEMP_ROOT}/dummy.tar.gz"
dummy_key="${TEMP_ROOT}/dummy-key"
: >"$dummy_bundle"
: >"${dummy_bundle}.sha256"
: >"$dummy_key"
chmod 600 "$dummy_key"

assert_rejected() {
  local expected="$1"
  shift
  local output
  local result
  set +e
  output="$(env SSH_KEY="$dummy_key" "$@" bash "$DEPLOY" "$dummy_bundle" 2>&1)"
  result=$?
  set -e
  if (( result == 0 )) || [[ "$output" != *"$expected"* ]]; then
    printf 'OMP rollout gate failed. Expected rejection containing %s, got:\n%s\n' "$expected" "$output" >&2
    exit 1
  fi
}

assert_rejected 'ALLOW_OMP_RUNTIME=true' env OMP_RUNTIME_ENABLED=true
assert_rejected 'ALLOW_OMP_HOST_TOOLS=true' env OMP_RUNTIME_ENABLED=true ALLOW_OMP_RUNTIME=true OMP_HOST_TOOLS_ENABLED=true
assert_rejected 'not available in the phase-one release' env OMP_RUNTIME_ENABLED=true ALLOW_OMP_RUNTIME=true OMP_HOST_TOOLS_ENABLED=true ALLOW_OMP_HOST_TOOLS=true
assert_rejected 'ALLOW_OMP_SUBAGENTS=true' env OMP_RUNTIME_ENABLED=true ALLOW_OMP_RUNTIME=true OMP_SUBAGENTS_ENABLED=true
assert_rejected 'not available in the phase-one release' env OMP_RUNTIME_ENABLED=true ALLOW_OMP_RUNTIME=true OMP_SUBAGENTS_ENABLED=true ALLOW_OMP_SUBAGENTS=true

printf '%s\n' 'OMP Runtime default-off rollout policy tests passed'
