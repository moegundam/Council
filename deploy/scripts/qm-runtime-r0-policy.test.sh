#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
adr="$repo_root/docs/architecture/QM_RUNTIME_ADOPTION_ADR_2026-08-03.md"
threat="$repo_root/docs/security/QM_RUNTIME_SANDBOX_THREAT_MODEL_2026-08-03.md"
ux="$repo_root/docs/product/QM_RUNTIME_PROFILE_UX_BRIEF_2026-08-03.md"
shell_source="$repo_root/apps/web/src/components/app-shell.tsx"

for document in "$adr" "$threat" "$ux"; do
  test -s "$document"
  chinese_line="$(grep -nE '^## 中文版$' "$document" | cut -d: -f1)"
  english_line="$(grep -nE '^## English [Vv]ersion$' "$document" | cut -d: -f1)"
  test -n "$chinese_line"
  test -n "$english_line"
  test "$chinese_line" -lt "$english_line"
done

for term in AgentHarness RuntimeProfile ExecutionScope SandboxBackend; do
  grep -q "$term" "$adr"
done
grep -q '不採用完整 QM 嵌入' "$adr"
grep -q '禁止 API/Worker 取得系統級 Docker socket' "$threat"
grep -q '缺省拒絕對外網 egress' "$threat"
grep -q '短效、可作用域憑證' "$threat"
grep -q 'Digest pins' "$threat"
grep -q 'TTL + reconciliation' "$threat"
grep -q 'stale-result rejection' "$threat"

for nav_item in \
  'href: "/", label: "討論"' \
  'href: "/tasks", label: "任務"' \
  'href: "/agents", label: "Agent"' \
  'href: "/settings", label: "設定"'; do
  grep -qF "$nav_item" "$shell_source"
done
grep -qF 'goalRunAutonomyUiEnabled ? [{ href: "/goals", label: "目標"' "$shell_source"
test "$(sed -n '/const navItems = \[/,/^\];/p' "$shell_source" | grep -c 'href:')" -eq 5

if grep -qE 'yc-software/qm|github\.com/yc-software/qm' \
  "$repo_root/package.json" "$repo_root/pnpm-lock.yaml"; then
  printf '%s\n' 'QM must remain an architectural reference, not a package dependency.' >&2
  exit 1
fi

printf '%s\n' 'QM runtime R0 policy tests passed'
