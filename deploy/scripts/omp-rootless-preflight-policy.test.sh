#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PREFLIGHT="${ROOT}/deploy/scripts/omp-rootless-preflight-remote.sh"
DEPLOY="${ROOT}/deploy/scripts/deploy-remote.sh"

grep -Fq 'newuidmap newgidmap rootlesskit slirp4netns' "$PREFLIGHT"
grep -Fq 'systemctl --user is-active --quiet docker.service' "$PREFLIGHT"
grep -Fq 'rootless Docker security option is absent' "$PREFLIGHT"
grep -Fq 'rootless Docker must use cgroup v2' "$PREFLIGHT"
grep -Fq 'MemoryLimit", "PidsLimit", "CpuCfsPeriod", "CpuCfsQuota' "$PREFLIGHT"
grep -Fq '"${SCRIPT_DIR}/omp-rootless-preflight-remote.sh" --run' "$DEPLOY"

if grep -Eq '(^|[[:space:]])(sudo|apt|apt-get|dnf|yum|pacman|systemctl --user (enable|start|restart)|dockerd-rootless-setuptool\.sh install|rm|mv|cp|install)([[:space:]]|$)' "$PREFLIGHT"; then
  printf '%s\n' 'OMP rootless preflight must remain read-only.' >&2
  exit 1
fi

printf '%s\n' 'OMP rootless preflight policy tests passed'
