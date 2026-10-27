# Sandbox 威脅模型 / Sandbox threat model

## 中文版

禁止 API/Worker 取得系統級 Docker socket。執行容器缺省拒絕對外網 egress，只取得短效、可作用域憑證。Runtime image 使用 Digest pins；工作空間及租約採 TTL + reconciliation；回傳結果使用輸入與設定 digest 執行 stale-result rejection。失敗時關閉執行能力而非放寬隔離。

## English version

API and Worker processes must not receive the system Docker socket. Execution containers deny outbound egress by default and receive short-lived scoped credentials. Runtime images use digest pins; workspaces and leases use TTL plus reconciliation; result admission rejects stale inputs and configuration. Failures close execution rather than weaken isolation.
