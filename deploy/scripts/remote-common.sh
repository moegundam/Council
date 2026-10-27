#!/usr/bin/env bash

set -euo pipefail

REMOTE_TARGET="${REMOTE_TARGET:-}"
REMOTE_JUMP="${REMOTE_JUMP:-}"
SSH_KEY="${SSH_KEY:-}"
REMOTE_HOST_KEY_ALIAS="${REMOTE_HOST_KEY_ALIAS:-}"

SSH_ARGS=()

configure_remote_ssh() {
  [[ -n "$REMOTE_TARGET" ]] || { printf 'REMOTE_TARGET must be set to user@host.\n' >&2; return 2; }
  [[ -n "$SSH_KEY" && -r "$SSH_KEY" ]] || { printf 'SSH_KEY must name a readable private key.\n' >&2; return 2; }
  SSH_ARGS=(
    -i "$SSH_KEY"
    -o BatchMode=yes
    -o ConnectTimeout=15
    -o ServerAliveInterval=10
    -o ServerAliveCountMax=2
  )
  if [[ -n "$REMOTE_JUMP" ]]; then
    SSH_ARGS+=(-J "$REMOTE_JUMP")
  fi
  if [[ -n "$REMOTE_HOST_KEY_ALIAS" ]]; then
    SSH_ARGS+=(-o "HostKeyAlias=${REMOTE_HOST_KEY_ALIAS}")
  fi
}

remote_ssh() {
  configure_remote_ssh
  ssh "${SSH_ARGS[@]}" "$REMOTE_TARGET" "$@"
}

remote_rsync() {
  configure_remote_ssh
  local source_path="$1"
  local destination_path="$2"
  local rsync_rsh
  rsync_rsh="ssh -i ${SSH_KEY} -o BatchMode=yes -o ConnectTimeout=15"
  if [[ -n "$REMOTE_JUMP" ]]; then
    rsync_rsh+=" -J ${REMOTE_JUMP}"
  fi
  if [[ -n "$REMOTE_HOST_KEY_ALIAS" ]]; then
    rsync_rsh+=" -o HostKeyAlias=${REMOTE_HOST_KEY_ALIAS}"
  fi
  rsync -a -e "$rsync_rsh" "$source_path" "${REMOTE_TARGET}:${destination_path}"
}
