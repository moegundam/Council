import type { Metadata } from "next";
import { AppShell } from "../../components/app-shell";

export const metadata: Metadata = {
  title: "此版本原始碼 | Council",
  description: "Council 的 AGPL 授權與對應原始碼入口"
};

export default function SourcePage() {
  const sourceUrl = process.env.NEXT_PUBLIC_SOURCE_URL?.trim();
  return (
    <AppShell>
      <main className="source-page">
        <p className="eyebrow">AGPL-3.0-only</p>
        <h1>此版本原始碼</h1>
        <p>此服務所用的 Council 版本以 GNU Affero General Public License v3.0 only 授權。對應原始碼應包含建置及執行此版本所需的完整內容。</p>
        {sourceUrl ? <a className="button primary" href={sourceUrl}>開啟對應原始碼</a> : <p className="callout warning">管理者尚未設定 <code>COUNCIL_SOURCE_URL</code>。公開服務前必須把它指向此部署對應的 tag 或 commit。</p>}
        <h2>Corresponding source</h2>
        <p>This Council service is licensed under AGPL-3.0-only. Operators must configure a link to the complete corresponding source for the deployed tag or commit before offering network access.</p>
      </main>
    </AppShell>
  );
}
