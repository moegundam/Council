#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/remote-common.sh"

RUN=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --run)
      RUN=true
      ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      exit 2
      ;;
  esac
  shift
done

if [[ "$RUN" != "true" ]]; then
  printf '%s\n' 'Dry run only. Use --run to execute read-only OMP rootless checks.'
  printf 'Target: %s via %s\n' "$REMOTE_TARGET" "${REMOTE_JUMP:-direct}"
  exit 0
fi

remote_ssh 'bash -s' <<'REMOTE'
set -euo pipefail

uid="$(id -u)"
user="$(id -un)"
socket="/run/user/${uid}/docker.sock"
failures=()

require_command() {
  local command_name="$1"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    failures+=("missing_command:${command_name}")
  fi
}

for command_name in docker dockerd-rootless.sh dockerd-rootless-setuptool.sh newuidmap newgidmap rootlesskit slirp4netns loginctl systemctl; do
  require_command "$command_name"
done

if ! awk -F: -v user="$user" '$1 == user && $3 >= 65536 { found=1 } END { exit !found }' /etc/subuid; then
  failures+=("missing_subuid_range:${user}")
fi
if ! awk -F: -v user="$user" '$1 == user && $3 >= 65536 { found=1 } END { exit !found }' /etc/subgid; then
  failures+=("missing_subgid_range:${user}")
fi
if [[ "$(loginctl show-user "$user" -p Linger --value 2>/dev/null || true)" != "yes" ]]; then
  failures+=("linger_disabled:${user}")
fi
if ! systemctl --user is-active --quiet docker.service 2>/dev/null; then
  failures+=("rootless_docker_service_inactive")
fi
if [[ ! -S "$socket" ]]; then
  failures+=("rootless_docker_socket_missing:${socket}")
fi

if (( ${#failures[@]} == 0 )); then
  info="$(DOCKER_HOST="unix://${socket}" docker info --format '{{json .}}')"
  INFO="$info" python3 - <<'PYTHON'
import json
import os

info = json.loads(os.environ["INFO"])
security = info.get("SecurityOptions", [])
if not any("rootless" in item for item in security if isinstance(item, str)):
    raise SystemExit("rootless Docker security option is absent")
if str(info.get("CgroupVersion")) != "2":
    raise SystemExit("rootless Docker must use cgroup v2")
for capability in ("MemoryLimit", "PidsLimit", "CpuCfsPeriod", "CpuCfsQuota"):
    if info.get(capability) is not True:
        raise SystemExit(f"rootless Docker does not enforce {capability}")
PYTHON
fi

if (( ${#failures[@]} != 0 )); then
  printf '%s\n' 'OMP rootless preflight failed:' >&2
  printf '  %s\n' "${failures[@]}" >&2
  exit 1
fi

printf 'OMP rootless preflight passed host=%s user=%s uid=%s socket=%s\n' \
  "$(hostname)" "$user" "$uid" "$socket"
REMOTE
