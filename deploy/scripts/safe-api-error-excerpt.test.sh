#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER="${SCRIPT_DIR}/safe-api-error-excerpt.py"
FIXTURE="$(mktemp -d)"

cleanup() {
  rm -rf "$FIXTURE"
}
trap cleanup EXIT

set +e
usage_output="$(python3 "$HELPER" 2>&1)"
usage_status=$?
set -e
if [[ "$usage_status" -ne 2 || "$usage_output" != 'Usage: safe-api-error-excerpt.py <response-file>' ]]; then
  printf 'Safe API excerpt helper did not fail closed without a response file.\n' >&2
  exit 1
fi

printf '%s' '{"error":{"code":"RESPONSE_CONTRACT_VIOLATION","message":"Bearer secret-token password=hunter2\nnext-line"}}' >"${FIXTURE}/api-error.json"
safe_output="$(python3 "$HELPER" "${FIXTURE}/api-error.json")"
for required in \
  '"code":"RESPONSE_CONTRACT_VIOLATION"' \
  '"body":"<omitted>"' \
  '"bodyBytes":'; do
  if [[ "$safe_output" != *"$required"* ]]; then
    printf 'Safe API excerpt is missing %s: %s\n' "$required" "$safe_output" >&2
    exit 1
  fi
done
for forbidden in 'secret-token' 'hunter2' 'Bearer' 'next-line'; do
  if [[ "$safe_output" == *"$forbidden"* ]]; then
    printf 'Safe API excerpt leaked response message content: %s\n' "$forbidden" >&2
    exit 1
  fi
done

printf '%s' 'Bearer unexpected-secret' >"${FIXTURE}/unexpected.txt"
unexpected_size="$(wc -c <"${FIXTURE}/unexpected.txt" | tr -d ' ')"
unexpected_output="$(python3 "$HELPER" "${FIXTURE}/unexpected.txt")"
if [[ "$unexpected_output" != "<unexpected response omitted; bytes=${unexpected_size}>" ]]; then
  printf 'Unexpected response content was not safely omitted: %s\n' "$unexpected_output" >&2
  exit 1
fi

printf '%s' '{"error":{"code":"bad-code","message":"must not appear"}}' >"${FIXTURE}/invalid-code.json"
invalid_size="$(wc -c <"${FIXTURE}/invalid-code.json" | tr -d ' ')"
invalid_output="$(python3 "$HELPER" "${FIXTURE}/invalid-code.json")"
if [[ "$invalid_output" != "<unexpected response omitted; bytes=${invalid_size}>" ]]; then
  printf 'Invalid error code was not safely omitted: %s\n' "$invalid_output" >&2
  exit 1
fi

dd if=/dev/zero of="${FIXTURE}/oversized.bin" bs=65537 count=1 2>/dev/null
oversized_output="$(python3 "$HELPER" "${FIXTURE}/oversized.bin")"
if [[ "$oversized_output" != '<unexpected response omitted; bytes=65537>' ]]; then
  printf 'Oversized response was not safely omitted: %s\n' "$oversized_output" >&2
  exit 1
fi

printf '%s\n' 'safe API error excerpt tests passed'
