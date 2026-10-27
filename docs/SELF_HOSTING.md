# 自架手冊 / Self-hosting

## 中文版

### 安裝與初始化

安裝 Node.js 22 或 24、pnpm 11.7.0、Docker Engine 與 Compose plugin。Clone 後執行：

```bash
pnpm install --frozen-lockfile
pnpm selfhost:init
pnpm selfhost:up
```

`selfhost:init` 以 `wx` 模式建立設定與 secrets；檔案已存在時不覆寫。Secrets 目錄為 `0700`，其中的 local-secret 檔案為唯讀 `0444`，讓 rootless Compose 掛載後的非 root 服務可讀；主機其他使用者無法穿越該目錄。請先檢查 `deploy/.env` 的 `PUBLIC_ORIGIN`、port 與 UID/GID。預設 gateway 只發布 `127.0.0.1:8787`。若要對外服務，請在受控反向代理後終結 TLS，保留登入，並自行設定可信網路與備份。

### 建立 Owner

密碼只由 stdin 傳入，不放在 shell argument 或設定檔：

```bash
printf '%s\n' '至少 12 字元的新密碼' | pnpm selfhost:create-owner -- owner@example.com
```

### 停止、更新與備份

`pnpm selfhost:down` 只停止容器，不加 `--volumes`。更新前備份 `deploy/data` 與 `deploy/secrets`，另以 `pg_dump` 產生 PostgreSQL 邏輯備份；在隔離環境驗證還原後再更新。切換版本時使用對應 tag 的完整原始碼，重新執行 migration 與 `pnpm verify`。

### 選用整合

OMP、Harness 與 model tunnel 預設關閉。model tunnel 需自行建立 `deploy/secrets/model_tunnel_key`、`model_tunnel_known_hosts`，設定 `MODEL_TUNNEL_SSH_HOST`／`MODEL_TUNNEL_SSH_USER`，再明確啟用 `--profile model-tunnel`。不要把私鑰提交到 Git。

## English version

Install Node.js 22 or 24, pnpm 11.7.0, Docker Engine, and the Compose plugin. Run `pnpm install --frozen-lockfile`, `pnpm selfhost:init`, and `pnpm selfhost:up`. Initialization creates files exclusively and never overwrites existing configuration or secrets. Review `deploy/.env` first. The gateway binds only to `127.0.0.1:8787` by default.

Create the Owner by piping a new password to `pnpm selfhost:create-owner -- owner@example.com`; the password is read only from stdin. `pnpm selfhost:down` preserves data. Back up both `deploy/data` and `deploy/secrets`, create a logical PostgreSQL dump, and prove restoration in an isolated environment before upgrades.

OMP, Harness, and the model tunnel are optional and disabled by default. The model tunnel requires operator-created key and known-hosts secret files plus explicit SSH host and user settings. Never commit private keys.
