#!/usr/bin/env bash

set -euo pipefail

smoke_read_env_value() {
  local env_file="$1"
  local key="$2"

  python3 - "$env_file" "$key" <<'PYTHON'
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
key = sys.argv[2]
if not path.is_file():
    raise SystemExit(f"Deployment environment file is missing: {path}")

matches = []
for line_number, raw_line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
    line = raw_line.strip()
    if not line or line.startswith("#"):
        continue
    name, separator, value = line.partition("=")
    if separator and name == key:
        if not value:
            raise SystemExit(f"Deployment environment marker is empty: {key} (line {line_number})")
        matches.append(value)

if len(matches) > 1:
    raise SystemExit(f"Deployment environment marker is duplicated: {key}")
print(matches[0] if matches else "")
PYTHON
}

smoke_deployment_class() {
  local env_file="$1"
  local marker
  marker="$(smoke_read_env_value "$env_file" SMOKE_DEPLOYMENT_CLASS)"
  if [[ -z "$marker" ]]; then
    marker=production
  fi
  case "$marker" in
    production|disposable|isolated)
      printf '%s\n' "$marker"
      ;;
    *)
      printf 'Unknown SMOKE_DEPLOYMENT_CLASS marker: %s\n' "$marker" >&2
      return 1
      ;;
  esac
}

smoke_node_environment() {
  local compose_config="$1"
  python3 - "$compose_config" <<'PYTHON'
import json
import sys

config = json.load(open(sys.argv[1], encoding="utf-8"))
environment = config.get("services", {}).get("api", {}).get("environment", {})
node_env = environment.get("NODE_ENV")
if not isinstance(node_env, str) or not node_env:
    raise SystemExit("Resolved API environment is missing NODE_ENV.")
print(node_env)
PYTHON
}

smoke_require_mutating_acceptance() {
  local target="$1"
  local env_file="$2"
  local compose_config="$3"
  local marker
  local node_env

  case "$target" in
    disposable|isolated)
      ;;
    *)
      printf 'Mutating acceptance fail closed: --target must be disposable or isolated (got %s).\n' "$target" >&2
      return 1
      ;;
  esac

  marker="$(smoke_deployment_class "$env_file")" || return 1
  node_env="$(smoke_node_environment "$compose_config")" || return 1
  if [[ "$marker" != "$target" ]]; then
    printf 'Mutating acceptance fail closed: SMOKE_DEPLOYMENT_CLASS=%s does not prove target=%s.\n' \
      "$marker" "$target" >&2
    return 1
  fi

  printf 'Mutating acceptance target verified target=%s SMOKE_DEPLOYMENT_CLASS=%s node_env=%s\n' \
    "$target" "$marker" "$node_env"
}
