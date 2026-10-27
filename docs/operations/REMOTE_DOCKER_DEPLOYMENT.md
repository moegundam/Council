# 通用遠端部署 / Generic remote deployment

## 中文版

先完成 [自架手冊](../SELF_HOSTING.md) 的本機驗證，再由操作者明確設定 `REMOTE_TARGET`、`SSH_KEY` 與選用 `REMOTE_JUMP`。腳本沒有私人主機、使用者、路徑或跳板預設。部署前確認 reader-first migration、`vault_v1` 憑證讀取相容性與 `agent-meeting-platform-app` Compose network；正式 secrets 不得進入 release archive 或 CI artifact。

## English version

Complete the [self-hosting guide](../SELF_HOSTING.md) first, then explicitly set `REMOTE_TARGET`, `SSH_KEY`, and the optional `REMOTE_JUMP`. Scripts contain no private host, user, path, or jump-host defaults. Validate reader-first migrations, `vault_v1` credential-read compatibility, and the `agent-meeting-platform-app` Compose network before deployment. Production secrets must never enter release archives or CI artifacts.
