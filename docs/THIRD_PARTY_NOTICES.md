# 第三方聲明 / Third-party notices

## 中文版

Council 自有程式、文件與合成素材採 `AGPL-3.0-only`；這不會取代任何第三方元件的授權。下列專案名稱與商標只用來說明相容性、來源或實際整合，不表示原作者或商標權人為 Council 背書。

### 需特別保留的聲明

| 元件 | 固定版本／來源 | 授權 | Council 中的用途與隨附證據 |
|---|---|---|---|
| Oh My Pi（OMP） | [`v18.1.2`](https://github.com/can1357/oh-my-pi/tree/v18.1.2) | MIT | 選用的 Pi-compatible 隔離 runtime。完整 MIT 文字與原作者 copyright notice 保存在 [`deploy/omp-runtime/LICENSE.omp`](../deploy/omp-runtime/LICENSE.omp)，image 內安裝到 `/usr/share/licenses/omp/LICENSE`；release asset checksum 與來源見 [`deploy/omp-runtime/THIRD_PARTY_NOTICES.md`](../deploy/omp-runtime/THIRD_PARTY_NOTICES.md)。 |
| OpenAI Codex CLI | [`@openai/codex@0.146.0`](https://www.npmjs.com/package/@openai/codex/v/0.146.0) | Apache-2.0 | 安裝於 Worker image；`CODEX_CLI_HARNESS_ENABLED` 預設為 `false`。套件及平台 binary 的授權 metadata 記錄於 [`worker.spdx.json.gz`](../sbom/containers/worker.spdx.json.gz)。 |
| Agent Control Specification | [`0.3.1-beta.0`](https://www.npmjs.com/package/agent-control-specification/v/0.3.1-beta.0) | MIT；其 OPA Linux 套件為 Apache-2.0 | 實驗性治理整合。精確平台套件與授權見 [`source-dependencies.spdx.json`](../sbom/source-dependencies.spdx.json)。 |
| Lucide React | [`1.24.0`](https://www.npmjs.com/package/lucide-react/v/1.24.0) | ISC | Web UI 與合成說明圖中的圖示；版本與授權見 source SBOM。 |
| caniuse-lite | [`1.0.30001805`](https://www.npmjs.com/package/caniuse-lite/v/1.0.30001805) | CC-BY-4.0 | 瀏覽器相容性資料；保留套件來源、版本及 CC-BY-4.0 attribution。 |
| Lightning CSS | [`1.32.0`](https://www.npmjs.com/package/lightningcss/v/1.32.0) | MPL-2.0 | Web 建置相依；原套件及平台 binary 保留 MPL-2.0，版本與授權見 source SBOM。 |
| sharp／libvips | `sharp 0.35.3`、`@img/sharp-libvips-linux-x64 1.3.2` | Apache-2.0；libvips 套件為 LGPL-3.0-or-later | Web image 中的圖片處理元件；來源與授權見 source SBOM 及 [`web.spdx.json.gz`](../sbom/containers/web.spdx.json.gz)。再散布 image 時須保留其中的授權檔、LGPL 適用來源與重新連結權利。 |

### 完整盤點與再散布

- [`source-dependencies.spdx.json`](../sbom/source-dependencies.spdx.json) 記錄鎖定的 npm 來源、版本、套件 URL 與宣告授權。
- [`sbom/containers`](../sbom/containers) 收錄實際建置或 digest 固定 image 的 SPDX 2.3 SBOM 與 `SHA256SUMS`，涵蓋 Node.js、Debian／Alpine、PostgreSQL 17.6、Redis 8.2.1、Caddy 2.10.2、Docker CLI 29.7.2、Codex CLI 及應用相依。
- SBOM 是盤點證據，不取代元件隨附的 LICENSE、NOTICE、來源提供或重新連結義務。發布 image 或二進位檔時，必須一併保留其中的上游授權檔與 notices；修改 MPL／LGPL 涵蓋檔案時，還須依相應條款提供修改後來源。
- Council 沒有把第三方程式改標為 AGPL，也沒有主張第三方專案名稱、標誌或著作權。

## English version

Council-owned code, documentation, and synthetic assets use `AGPL-3.0-only`; that license does not replace any third-party terms. Project names and trademarks below identify compatibility, provenance, or an actual integration only. They do not imply endorsement of Council by their authors or trademark owners.

### Notices that require particular preservation

| Component | Pinned version/source | License | Use in Council and shipped evidence |
|---|---|---|---|
| Oh My Pi (OMP) | [`v18.1.2`](https://github.com/can1357/oh-my-pi/tree/v18.1.2) | MIT | Optional Pi-compatible isolated runtime. The complete MIT text and upstream copyright notice are preserved in [`deploy/omp-runtime/LICENSE.omp`](../deploy/omp-runtime/LICENSE.omp) and installed in the image at `/usr/share/licenses/omp/LICENSE`; release checksum and provenance are in [`deploy/omp-runtime/THIRD_PARTY_NOTICES.md`](../deploy/omp-runtime/THIRD_PARTY_NOTICES.md). |
| OpenAI Codex CLI | [`@openai/codex@0.146.0`](https://www.npmjs.com/package/@openai/codex/v/0.146.0) | Apache-2.0 | Installed in the Worker image while `CODEX_CLI_HARNESS_ENABLED` defaults to `false`. License metadata for the package and platform binary is recorded in [`worker.spdx.json.gz`](../sbom/containers/worker.spdx.json.gz). |
| Agent Control Specification | [`0.3.1-beta.0`](https://www.npmjs.com/package/agent-control-specification/v/0.3.1-beta.0) | MIT; its OPA Linux package is Apache-2.0 | Experimental governance integration. Exact platform packages and licenses are listed in [`source-dependencies.spdx.json`](../sbom/source-dependencies.spdx.json). |
| Lucide React | [`1.24.0`](https://www.npmjs.com/package/lucide-react/v/1.24.0) | ISC | Icons in the Web UI and synthetic documentation images; version and license are recorded in the source SBOM. |
| caniuse-lite | [`1.0.30001805`](https://www.npmjs.com/package/caniuse-lite/v/1.0.30001805) | CC-BY-4.0 | Browser compatibility data; retain its source, version, and CC-BY-4.0 attribution. |
| Lightning CSS | [`1.32.0`](https://www.npmjs.com/package/lightningcss/v/1.32.0) | MPL-2.0 | Web build dependency; the original package and platform binary retain MPL-2.0, with versions and licenses in the source SBOM. |
| sharp/libvips | `sharp 0.35.3`, `@img/sharp-libvips-linux-x64 1.3.2` | Apache-2.0; the libvips package is LGPL-3.0-or-later | Image processing in the Web image; provenance and licenses appear in the source SBOM and [`web.spdx.json.gz`](../sbom/containers/web.spdx.json.gz). Image redistribution must preserve included license files, applicable LGPL source access, and relinking rights. |

### Complete inventory and redistribution

- [`source-dependencies.spdx.json`](../sbom/source-dependencies.spdx.json) records pinned npm sources, versions, package URLs, and declared licenses.
- [`sbom/containers`](../sbom/containers) contains SPDX 2.3 inventories and `SHA256SUMS` for the built or digest-pinned images, including Node.js, Debian/Alpine, PostgreSQL 17.6, Redis 8.2.1, Caddy 2.10.2, Docker CLI 29.7.2, Codex CLI, and application dependencies.
- An SBOM is inventory evidence; it does not replace an included LICENSE or NOTICE, source-availability duty, or relinking right. Distributors of images or binaries must retain upstream license files and notices. Modifications to MPL- or LGPL-covered files also require the corresponding modified source under those terms.
- Council does not relicense third-party code as AGPL and claims no ownership of third-party project names, marks, or copyrights.
