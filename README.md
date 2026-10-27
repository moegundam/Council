# Council｜多 Agent 會議與任務平台

## 中文版

Council 是供開發者、研究團隊與小型技術團隊自行部署的多 Agent 會議與任務平台。產品主線是「討論 → 決議 → 任務 → 證據」，並提供 Agent、Role、Skill、Model Connector、MCP Connector 與治理邊界。

這是**自架預覽版**。討論、議程、三種會議模式、決議、Task／Evidence／History、Agent 與資源管理是核心範圍。Goal Run、OMP、Harness 與 ACS 原始碼保留，但屬實驗功能且預設關閉。Plane／Jira／Linear 專用 Adapter、多租戶 SaaS、託管服務與任意流程編輯器不在本版承諾內。

### 合成 demo

需求：Node.js 22 或 24、pnpm 11.7.0。

```bash
pnpm install --frozen-lockfile
pnpm demo
```

開啟 `http://127.0.0.1:3000`。Demo 使用記憶體內合成資料，不需要模型金鑰，也不代表背景 Worker 或真實模型已執行；請勿把 demo 帳密或 fixture 用於正式環境。

### 完整自架預覽

需求：一般 Linux 主機、Docker Engine 與 Compose plugin。預設只有 gateway 綁定主機 loopback；PostgreSQL、Redis、API、Worker 與 Web 不發布主機 port。

```bash
pnpm install --frozen-lockfile
pnpm selfhost:init
pnpm selfhost:up
printf '%s\n' '至少 12 字元的新密碼' | pnpm selfhost:create-owner -- owner@example.com
```

初始化只建立不存在的 `deploy/.env`、本機資料目錄與 secrets，不覆寫既有值；`pnpm selfhost:down` 不刪除 volume 或資料。完整設定、更新與備份程序見 [自架手冊](docs/SELF_HOSTING.md)。

### 安全與整合邊界

- API 開發預設只監聽 `127.0.0.1`；容器才明確設定內部 `0.0.0.0`。
- auth bypass、test login、Tailnet quick login、OMP 與 Harness 預設關閉。
- model tunnel 是選用 profile；啟用時必須明確提供 SSH host、user、key 與 known_hosts。
- 模型採 OpenAI-compatible 接口，使用者自行提供服務與憑證；專案不附模型、帳號或金鑰。
- Reference Task Adapter 是參考實作，不代表特定外部工作管理平台已支援。

漏洞請依 [SECURITY.md](SECURITY.md) 私下回報。支援範圍見 [docs/SUPPORT.md](docs/SUPPORT.md)，貢獻方式見 [CONTRIBUTING.md](CONTRIBUTING.md)。

本專案自有程式、文件與合成素材採 [`AGPL-3.0-only`](LICENSE)；第三方內容保留原條款，見 [第三方聲明](docs/THIRD_PARTY_NOTICES.md)。

## English version

Council is a self-hosted multi-agent meeting and task platform for developers, research groups, and small technical teams. Its main workflow is discussion → decision → task → evidence, with Agent, Role, Skill, model, MCP, and governance management.

This is a **self-hosted preview**. Discussions, agendas, meeting modes, decisions, Task/Evidence/History, and resource management form the core scope. Goal Run, OMP, Harness, and ACS remain experimental and disabled by default. Dedicated Plane/Jira/Linear adapters, multi-tenant SaaS, a hosted service, and an arbitrary workflow editor are outside this release.

For a synthetic, keyless demo, install Node.js 22 or 24 and pnpm 11.7.0, then run `pnpm install --frozen-lockfile` and `pnpm demo`. Open `http://127.0.0.1:3000`. The demo uses in-memory synthetic data and does not claim that a real model or background Worker ran.

For the Linux Docker Compose preview, run `pnpm selfhost:init`, `pnpm selfhost:up`, then pipe a new 12-character-or-longer password to `pnpm selfhost:create-owner -- owner@example.com`. Initialization never overwrites an existing environment or secret, and `pnpm selfhost:down` preserves data. See [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md).

Development API binding defaults to loopback. Authentication bypasses, quick login, OMP, Harness, and the optional model tunnel are disabled by default. Users provide their own OpenAI-compatible endpoints and credentials. Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

Project-owned code, documentation, and synthetic assets are licensed under [`AGPL-3.0-only`](LICENSE). Third-party material keeps its original terms; see [docs/THIRD_PARTY_NOTICES.md](docs/THIRD_PARTY_NOTICES.md).
