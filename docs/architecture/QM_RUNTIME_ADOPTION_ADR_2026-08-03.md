# 實驗執行層採用決策 / Experimental runtime adoption ADR

## 中文版

平台保留 `AgentHarness`、`RuntimeProfile`、`ExecutionScope` 與 `SandboxBackend` 的窄介面，以便選用隔離執行；首版不採用完整 QM 嵌入。所有實驗 runtime 預設關閉，不能取得平台主資料庫憑證或系統級容器控制權。

## English version

The platform retains narrow `AgentHarness`, `RuntimeProfile`, `ExecutionScope`, and `SandboxBackend` interfaces for optional isolated execution. The preview does not embed a complete QM runtime. Experimental runtimes stay disabled by default and receive neither primary database credentials nor system-level container control.
