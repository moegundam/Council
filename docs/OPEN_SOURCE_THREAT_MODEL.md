# 開源自架威脅模型 / Open-source self-hosting threat model

## 中文版

保護目標包括 Owner session、模型與 MCP 憑證、會議內容、任務證據、資料庫與主金鑰。主要信任邊界是瀏覽器→gateway→API、API／Worker→PostgreSQL／Redis、Worker→模型／MCP，以及選用的 Worker→sandbox broker→rootless runtime。

主要威脅與控制：未認證存取由預設啟用登入、loopback gateway 與 production bypass 雙重開關降低；SSRF 由 connector URL 驗證與 allowlist 限制；憑證外洩由 secret files、資料庫加密、日誌遮蔽與輪替處理；任意工具執行由人工核准、digest、權限縮減及實驗功能預設關閉限制；供應鏈風險由鎖檔、image digest、SBOM、秘密掃描與 CI 降低。

自架者仍負責 TLS、主機安全、備份、網路 ACL、模型供應商資料政策及 incident response。啟用 OMP、Harness、model tunnel 或外部 connector 會增加攻擊面，必須另做部署特定審查。

## English version

Assets include Owner sessions, model and MCP credentials, meeting content, task evidence, the database, and the application master key. Trust boundaries cover browser→gateway→API, API/Worker→PostgreSQL/Redis, Worker→model/MCP, and the optional Worker→sandbox broker→rootless runtime path.

Default authentication, loopback exposure, two-switch production bypass, connector URL validation, allowlists, secret files, encrypted stored credentials, log redaction, approval and digest checks, disabled experimental features, lockfiles, image digests, SBOMs, secret scanning, and CI reduce the principal risks. Operators remain responsible for TLS, host security, backups, network policy, provider data terms, and incident response. Optional integrations require a deployment-specific review.
