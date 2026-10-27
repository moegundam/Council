#!/bin/sh

set -eu

: "${COUNCIL_OMP_VERSION:?COUNCIL_OMP_VERSION is required}"

approved_agent_dir=/opt/council-omp-config
if [ "${HOME:-}" != "/home/omp" ] || [ "${PI_CODING_AGENT_DIR:-}" != "$approved_agent_dir" ]; then
  printf '%s\n' 'Council OMP runtime paths do not match the approved container contract.' >&2
  exit 1
fi

native_source=/usr/local/bin/pi_natives.linux-x64-baseline.node
native_dir="${HOME}/.omp/natives/${COUNCIL_OMP_VERSION}"
native_target="${native_dir}/pi_natives.linux-x64-baseline.node"

test -r "$native_source"
mkdir -p "$native_dir"
if [ -e "$native_target" ] && [ ! -L "$native_target" ]; then
  printf '%s\n' 'Council OMP native addon target is not an approved symlink.' >&2
  exit 1
fi
rm -f "$native_target"
ln -s "$native_source" "$native_target"

exec /usr/local/bin/omp "$@"
