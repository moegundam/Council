# Container SBOMs

## 中文版

這個目錄收錄預設自架服務與選用服務的 SPDX 2.3 SBOM。檔案由固定版 Syft `v1.55.0` 掃描實際建置或固定 digest 的 image，再以 deterministic gzip header 壓縮。執行 `pnpm sbom:containers` 可重建；`SHA256SUMS` 用來核對本候選版本的產物。

應用 image 必須先由本版 `deploy/compose.yaml` 建置。PostgreSQL、Redis 與 Caddy 使用 Compose 內固定的 upstream digest。SBOM 是元件盤點證據，不取代各元件的 LICENSE、NOTICE 或漏洞處置。

## English version

This directory contains SPDX 2.3 SBOMs for the default and optional self-hosted services. A pinned Syft `v1.55.0` image scans the actual built images or digest-pinned upstream images, and the results use deterministic gzip headers. Run `pnpm sbom:containers` to rebuild them; `SHA256SUMS` binds the artifacts to this candidate.

Build the application images from this revision's `deploy/compose.yaml` first. PostgreSQL, Redis, and Caddy use the upstream digests pinned by Compose. An SBOM is inventory evidence; it does not replace component LICENSE or NOTICE files or vulnerability remediation.
