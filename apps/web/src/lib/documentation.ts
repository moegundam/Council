export type DocumentationCategoryId =
  | "quick-start"
  | "discussions"
  | "agents"
  | "tasks"
  | "resources"
  | "security";

export type DocumentationCategory = {
  id: DocumentationCategoryId;
  label: string;
  description: string;
};

export type DocumentationSection = {
  title: string;
  paragraphs?: string[];
  steps?: string[];
  bullets?: string[];
};

export type DocumentationArticle = {
  id: string;
  categoryId: DocumentationCategoryId;
  title: string;
  summary: string;
  aliases: string[];
  keywords: string[];
  audience: string[];
  readMinutes: number;
  action: { label: string; href: string };
  image: { src: string; width: number; height: number; alt: string; caption: string };
  sections: DocumentationSection[];
  callout?: { tone: "info" | "warning"; title: string; body: string };
  relatedArticleIds: string[];
};

export const documentationCategories: DocumentationCategory[] = [
  { id: "quick-start", label: "快速開始", description: "平台結構、固定流程與第一次操作。" },
  { id: "discussions", label: "討論與會議", description: "話題、場次、議程、主席與決議。" },
  { id: "agents", label: "Agent 與角色", description: "Agent 版本、角色、Team 與會議範本。" },
  { id: "tasks", label: "決議與任務", description: "任務看板、Agent 執行、證據與同步。" },
  { id: "resources", label: "資源與整合", description: "金鑰、模型、Prompt、Skill、MCP 與 Adapter。" },
  { id: "security", label: "安全與維運", description: "權限邊界、故障保留、備份與復原。" }
];

export const documentationArticles: DocumentationArticle[] = [
  {
    id: "platform-overview",
    categoryId: "quick-start",
    title: "認識 Council 與固定工作流程",
    summary: "先掌握四個工作入口，以及討論如何轉成決議與任務。",
    aliases: ["首頁", "導覽", "新手入門"],
    keywords: ["討論", "任務", "Agent", "設定", "固定流程"],
    audience: ["Owner", "所有使用者"],
    readMinutes: 3,
    action: { label: "前往討論", href: "/" },
    image: {
      src: "/docs/platform-overview.png", width: 1440, height: 900,
      alt: "Council 討論頁顯示四個主導覽、參與者、決議與固定流程",
      caption: "Council 將日常操作收斂在討論、任務、Agent、設定四個入口。"
    },
    sections: [
      {
        title: "四個入口",
        bullets: [
          "討論：管理分類、話題、會議、主席協助與決議。",
          "任務：追蹤待辦、進行中、審查與完成。",
          "Agent：組裝、發布及檢查 Agent，並管理 Team 與會議範本。",
          "設定：治理 Role、Skill、Prompt、模型、API 金鑰、MCP 與 Adapter。"
        ]
      },
      {
        title: "建議使用順序",
        steps: [
          "先在設定建立可重用資源，再到 Agent 完成組裝與發布。",
          "建立 Agent Team 與 Meeting Preset，避免每場會議重複配置。",
          "從話題建立會議，形成決議，再把已核准決議轉成任務。"
        ]
      }
    ],
    callout: { tone: "info", title: "固定邊界", body: "Phase 1 固定為討論 → 決議 → 任務，不提供任意流程設計器。" },
    relatedArticleIds: ["first-meeting-checklist", "meeting-from-preset", "decision-to-task"]
  },
  {
    id: "first-meeting-checklist",
    categoryId: "quick-start",
    title: "第一次多 Agent 會議檢查表",
    summary: "用最短路徑確認 Agent、主席、議程與執行資源都可用。",
    aliases: ["第一次開會", "開會準備", "preflight"],
    keywords: ["Agent", "主席", "議程", "readiness", "會議"],
    audience: ["Owner", "會議主持人"],
    readMinutes: 4,
    action: { label: "管理 Agent", href: "/agents" },
    image: {
      src: "/docs/meeting-preset.jpg", width: 1440, height: 900,
      alt: "Council 建立會議表單顯示 Agent 參與者、角色與主席設定",
      caption: "開會前先確認每位 Agent 的角色、主席與 readiness。"
    },
    sections: [
      {
        title: "開會前",
        bullets: ["至少兩個已發布且 ready 的 Agent。", "Team 內恰好一位主席。", "Preset 有明確目標、時間與 1 至 12 項議程。"]
      },
      {
        title: "建立場次",
        steps: [
          "在討論頁選擇或建立 Topic，按「開始新會議」。",
          "套用 Meeting Preset，檢查參與者與議程，再執行 preflight。",
          "只在全部必要 Agent ready 時建立場次，開始後依議程推進。"
        ]
      }
    ],
    callout: { tone: "warning", title: "雲端模型", body: "雲端 Connector 沒有有效 Credential 時會被阻擋；不要用假 Key 略過檢查。" },
    relatedArticleIds: ["agent-readiness", "agent-teams-and-presets", "meeting-agenda"]
  },
  {
    id: "discussion-taxonomy",
    categoryId: "discussions",
    title: "建立 Group、Category、Topic 與 Tag",
    summary: "用三層分類與標籤整理不同團隊、領域和討論話題。",
    aliases: ["群組", "分類", "話題", "標籤"],
    keywords: ["Group", "Category", "Topic", "Tag", "整理分類"],
    audience: ["Owner", "討論管理員"],
    readMinutes: 4,
    action: { label: "整理討論", href: "/" },
    image: {
      src: "/docs/discussion-taxonomy.jpg", width: 1440, height: 900,
      alt: "Council 討論側欄以 Group、Category、Topic 階層呈現話題",
      caption: "左側垂直樹直接呈現 Group → Category → Topic 與場次數量。"
    },
    sections: [
      {
        title: "分類原則",
        paragraphs: ["Group 表示組織或大型領域，Category 表示穩定分類，Topic 是實際累積多場會議的工作話題；Tag 用於跨分類標記。"]
      },
      {
        title: "建立與調整",
        steps: [
          "按側欄的「整理分類」建立或重新命名 Group、Category 與 Tag。",
          "新增 Topic 時選擇 Category，填寫標題、摘要並套用必要 Tag。",
          "需求改變時移動 Category 或 Topic，不必重建既有會議歷史。"
        ]
      }
    ],
    callout: { tone: "warning", title: "封存限制", body: "Topic 尚有未結束會議時，不能結案或封存。" },
    relatedArticleIds: ["topic-search-lifecycle", "meeting-from-preset"]
  },
  {
    id: "topic-search-lifecycle",
    categoryId: "discussions",
    title: "搜尋、篩選與封存話題",
    summary: "依文字、狀態與 Tag 快速縮小話題範圍，並維護生命週期。",
    aliases: ["找話題", "結案", "重開", "封存"],
    keywords: ["搜尋", "篩選", "open", "resolved", "archived"],
    audience: ["Owner", "會議主持人"],
    readMinutes: 3,
    action: { label: "尋找話題", href: "/" },
    image: {
      src: "/docs/topic-search.jpg", width: 1440, height: 900,
      alt: "Council 討論側欄顯示搜尋、狀態與標籤篩選結果",
      caption: "搜尋會比對話題、分類與標籤，再與狀態條件取交集。"
    },
    sections: [
      { title: "縮小範圍", steps: ["開啟側欄篩選，輸入標題、摘要、Group、Category 或 Tag。", "選擇一個生命週期狀態與 Tag，查看交集結果。", "按清除條件回到完整分類樹。"] },
      { title: "生命週期", bullets: ["open：仍在進行。", "resolved：工作已解決，可重新開啟。", "archived：保留歷史但離開日常清單。"] }
    ],
    relatedArticleIds: ["discussion-taxonomy", "meeting-from-preset"]
  },
  {
    id: "meeting-from-preset",
    categoryId: "discussions",
    title: "套用 Agent Team 與會議範本開會",
    summary: "從可重用 roster 和議程快速建立一場仍可微調的會議。",
    aliases: ["Meeting Preset", "會議模板", "套用團隊"],
    keywords: ["Agent Team", "Meeting Preset", "preflight", "參與者", "角色"],
    audience: ["Owner", "會議主持人"],
    readMinutes: 5,
    action: { label: "開始會議", href: "/" },
    image: {
      src: "/docs/meeting-preset.jpg", width: 1440, height: 900,
      alt: "Council 會議建立表單套用 Team 後顯示參與 Agent 與 Role",
      caption: "Preset 帶入 Team、模式、主席協助、時間與議程，建立前仍可調整。"
    },
    sections: [
      { title: "套用與檢查", steps: ["在 Topic 按「開始新會議」，選擇一個有效 Meeting Preset。", "確認帶入的 Agent、Role、主席、時限與議程符合本次目的。", "執行 preflight，處理所有 blocked 項目後建立會議。"] },
      { title: "快照規則", paragraphs: ["建立後會保存 Team、Preset 來源及 Agent/Role revision 快照。日後編輯 Team 或 Agent，不會改寫已建立的會議。"] }
    ],
    callout: { tone: "info", title: "可以微調", body: "Preset 是起點，不是鎖死的流程；建立前可調整參與者與議程。" },
    relatedArticleIds: ["agent-teams-and-presets", "agent-readiness", "meeting-agenda"]
  },
  {
    id: "meeting-agenda",
    categoryId: "discussions",
    title: "建立並推進會議議程",
    summary: "用 1 至 12 項 Agenda 控制會議焦點、進度與 Agent 執行邊界。",
    aliases: ["Agenda", "議程進度", "跳過議程"],
    keywords: ["議程", "完成", "跳過", "revision", "目前項目"],
    audience: ["會議主持人", "Owner"],
    readMinutes: 4,
    action: { label: "查看會議", href: "/" },
    image: {
      src: "/docs/meeting-agenda.jpg", width: 1440, height: 900,
      alt: "Council 會議議程視窗列出三個項目與完成、跳過狀態",
      caption: "議程視窗保存每一項的順序、說明與執行狀態。"
    },
    sections: [
      { title: "建立議程", steps: ["在 Meeting 草稿加入 1 至 12 項不重複標題。", "為需要背景的項目補上說明，確認順序後建立或更新。", "開始會議後，目前項目會成為 Agent turn 的固定執行綁定。"] },
      { title: "進行會議", bullets: ["完成：記錄議程已處理並推進下一項。", "跳過：保留跳過狀態並繼續。", "會議暫停或結束後，議程改為唯讀。"] }
    ],
    relatedArticleIds: ["meeting-from-preset", "chair-assistance"]
  },
  {
    id: "chair-assistance",
    categoryId: "discussions",
    title: "使用主席協助控制離題、重複與時間",
    summary: "依情境切換手動、建議或有限自動策略，維持討論秩序。",
    aliases: ["主持模式", "自動主席", "主席 Agent"],
    keywords: ["主席", "離題", "重複發言", "時間不足", "auto"],
    audience: ["Owner", "會議主席"],
    readMinutes: 5,
    action: { label: "開啟討論", href: "/" },
    image: {
      src: "/docs/chair-assistance.png", width: 1440, height: 900,
      alt: "Council 會議上方顯示主席協助策略與已指派主席 Agent",
      caption: "主席協助策略可逐場選擇，Owner 隨時保有降級控制權。"
    },
    sections: [
      { title: "選擇策略", bullets: ["手動：不分析、不提出建議。", "建議：分析後由 Owner 核准模式、主席介入或換角。", "有限自動：只會收緊模式或排入一次已指派主席 Agent。"] },
      { title: "處理建議", steps: ["查看建議原因、分數與目標 Agent/Role。", "核准安全的模式或 Role 建議，或要求主席 Agent 發言。", "若資訊不足就忽略；需要人工接管時切回建議或手動。"] }
    ],
    callout: { tone: "warning", title: "不會自動決策", body: "主席 Agent 不會自動核准 Decision、建立 Task、任意選角或呼叫工具。" },
    relatedArticleIds: ["meeting-agenda", "roles-and-switching", "safety-boundaries"]
  },
  {
    id: "decisions-and-evidence",
    categoryId: "discussions",
    title: "整理決議與會議證據",
    summary: "從逐字稿建立 proposed Decision，核准前保留人工治理。",
    aliases: ["Decision", "會議證據", "逐字稿"],
    keywords: ["決議", "核准", "拒絕", "Evidence", "來源"],
    audience: ["Owner", "決策者"],
    readMinutes: 4,
    action: { label: "查看討論", href: "/" },
    image: {
      src: "/docs/platform-overview.png", width: 1440, height: 900,
      alt: "Council 會議內容旁顯示決議數量、來源訊息與任務關係",
      caption: "決議留在來源 Meeting 中，由 Owner 核准或拒絕。"
    },
    sections: [
      { title: "建立決議", steps: ["在目前 Meeting 的決議區按新增，填寫標題與可執行內容。", "核對逐字稿、Tool Run 或其他 Evidence，再保存 proposed Decision。", "由 Owner 核准或拒絕；只有核准項目可建立 Task。"] },
      { title: "判讀來源", bullets: ["human：人工輸入。", "inference：模型產出，仍需驗證。", "verified：受控工具或流程確認。", "failure/system：故障或系統事件。"] }
    ],
    relatedArticleIds: ["decision-to-task", "task-evidence-sync"]
  },
  {
    id: "agent-create-publish",
    categoryId: "agents",
    title: "建立、組裝與發布 Agent",
    summary: "把模型、Prompt、Skill、工具與資料邊界組成不可變 Agent revision。",
    aliases: ["新增 Agent", "發布 Agent", "Agent revision"],
    keywords: ["draft", "published", "模型", "Prompt", "Skill"],
    audience: ["平台管理員", "Agent 設計者"],
    readMinutes: 5,
    action: { label: "管理 Agent", href: "/agents" },
    image: {
      src: "/docs/agent-management.png", width: 1440, height: 1123,
      alt: "Council Agent 詳情顯示發布控制、readiness 與有效組態",
      caption: "Agent 編輯只改 draft；發布後形成可供 Meeting 與 Task 使用的 revision。"
    },
    sections: [
      { title: "組裝草稿", steps: ["建立 Agent 名稱、描述與目標／工具／資料摘要。", "選擇 Model Connector、已發布 Prompt version、有效 Skill 與唯讀 Tool Grant。", "儲存草稿後查看 readiness，修正所有 blocked 原因。"] },
      { title: "發布與回復", bullets: ["發布會建立不可變 revision。", "之後編輯會產生新 draft，不影響已發布執行。", "回復會以舊 revision 內容建立新的遞增版本，不改寫歷史。"] }
    ],
    relatedArticleIds: ["agent-readiness", "prompts-and-skills", "credentials-and-models"]
  },
  {
    id: "agent-readiness",
    categoryId: "agents",
    title: "判讀 Readiness 與 Effective Configuration",
    summary: "在執行前看清楚 Agent 真正使用的模型、金鑰狀態、Prompt、Skill 與工具。",
    aliases: ["有效組態", "準備狀態", "blocked Agent"],
    keywords: ["readiness", "Effective Configuration", "credential", "tool grant", "warning"],
    audience: ["Agent 設計者", "會議主持人"],
    readMinutes: 4,
    action: { label: "檢查 Agent", href: "/agents" },
    image: {
      src: "/docs/agent-management.png", width: 1440, height: 1123,
      alt: "Council Agent 頁列出 lifecycle、model、credential、prompt、skill 與 tool 檢查",
      caption: "Readiness 顯示每個依賴的通過、警告或阻擋原因。"
    },
    sections: [
      { title: "檢查項目", bullets: ["lifecycle：必須有可執行的 published revision。", "model/credential：Connector 啟用且必要 secret revision 有效。", "prompt/skill/tool：固定版本、digest 與 grant 仍然有效。"] },
      { title: "執行前確認", steps: ["在 Agent 詳情展開 Readiness checks。", "開啟 Effective Configuration，核對實際生效資源而非只看草稿。", "blocked 時回到對應 Registry 修正，再重新執行 preflight。"] }
    ],
    relatedArticleIds: ["agent-create-publish", "credentials-and-models", "meeting-from-preset"]
  },
  {
    id: "roles-and-switching",
    categoryId: "agents",
    title: "建立 Role 並在會中切換分工",
    summary: "用角色定義責任、發言、決策、工具與資料政策，並保留換角歷程。",
    aliases: ["Agent 角色", "換角", "角色版本"],
    keywords: ["Role", "責任", "工具政策", "資料政策", "role revision"],
    audience: ["平台管理員", "會議主席"],
    readMinutes: 5,
    action: { label: "管理角色", href: "/settings" },
    image: {
      src: "/docs/role-management.jpg", width: 1425, height: 891,
      alt: "Council 設定頁顯示角色用途、責任、有效能力與版本操作",
      caption: "Role 是單場會議的責任視角，與 Agent 的長期能力身分分開。"
    },
    sections: [
      { title: "定義角色", steps: ["從平台架構師、會議主席、安全審查、證據分析模板或自訂內容開始。", "填寫適用情境、責任、發言準則、決策範圍與限制。", "選擇工具與資料政策，儲存後確認有效能力。"] },
      { title: "會中換角", bullets: ["未結束 Meeting 可切換單一參與者 Role。", "必須填寫原因並使用目前 role revision。", "系統保存前後快照、歷程與 audit，舊 Worker 結果不能提交。"] }
    ],
    relatedArticleIds: ["agent-teams-and-presets", "chair-assistance"]
  },
  {
    id: "agent-teams-and-presets",
    categoryId: "agents",
    title: "管理 Agent Team 與 Meeting Preset",
    summary: "保存可重用的參與者、角色、主席和議程，讓重複會議更快。",
    aliases: ["代理團隊", "會議範本", "roster"],
    keywords: ["Agent Team", "Meeting Preset", "唯一主席", "議程", "重用"],
    audience: ["Agent 管理員", "會議主持人"],
    readMinutes: 5,
    action: { label: "管理 Team", href: "/agents" },
    image: {
      src: "/docs/agent-management.png", width: 1440, height: 1123,
      alt: "Council Agent 側欄提供 Agent Team 與會議範本管理入口",
      caption: "Team 管 roster，Preset 管這類會議的模式、時間與議程。"
    },
    sections: [
      { title: "建立 Team", steps: ["在 Agent 頁按 Agent Team，建立名稱與用途。", "加入不重複的 Agent，為每位選擇有效 Role。", "指定恰好一位唯一主席並啟用 Team。"] },
      { title: "建立 Preset", steps: ["在 Agent 頁按會議範本，選擇 Team。", "設定發言模式、主席協助、時限與 1 至 12 項議程。", "啟用後可在 Topic 建立會議時套用；封存不破壞舊 Meeting 快照。"] }
    ],
    relatedArticleIds: ["meeting-from-preset", "roles-and-switching", "agent-readiness"]
  },
  {
    id: "decision-to-task",
    categoryId: "tasks",
    title: "從核准決議建立任務",
    summary: "把會議結論轉成有負責人、期限、驗收與執行邊界的 Task。",
    aliases: ["Decision 轉 Task", "任務分派", "建立工作"],
    keywords: ["Decision", "Task", "核准", "負責人", "驗收條件"],
    audience: ["Owner", "專案負責人"],
    readMinutes: 4,
    action: { label: "查看任務", href: "/tasks" },
    image: {
      src: "/docs/task-agent.png", width: 1440, height: 900,
      alt: "Council 任務詳情顯示標題、執行方式、負責 Agent 與驗收條件",
      caption: "Task 保存來源 Decision 與 Meeting，並明確描述完成條件。"
    },
    sections: [
      { title: "建立條件", paragraphs: ["Decision 必須先由 Owner 核准，而且同一 Decision 最多建立一個 Task。"] },
      { title: "建立任務", steps: ["在已核准 Decision 按建立 Task。", "填寫標題、工作說明、驗收條件、期限與負責人。", "選擇人工、Agent 顧問或 Agent 產出，確認工具與資料邊界後保存。"] }
    ],
    relatedArticleIds: ["decisions-and-evidence", "task-board", "task-agent-execution"]
  },
  {
    id: "task-board",
    categoryId: "tasks",
    title: "使用四狀態任務看板",
    summary: "在待辦、進行中、審查、完成之間拖拉，手機則用移動命令。",
    aliases: ["Kanban", "拖拉任務", "任務狀態"],
    keywords: ["待辦", "進行中", "審查", "完成", "拖拉"],
    audience: ["所有執行者", "Owner"],
    readMinutes: 3,
    action: { label: "開啟任務看板", href: "/tasks" },
    image: {
      src: "/docs/task-agent.png", width: 1440, height: 900,
      alt: "Council 任務頁背景顯示待辦、進行中、審查與完成四欄",
      caption: "桌面可拖拉卡片；手機使用前後移動命令以保持穩定操作。"
    },
    sections: [
      { title: "更新狀態", steps: ["在桌面拖曳 Task 到目標欄，或開啟卡片使用移動命令。", "確認新的狀態符合實際工作進度。", "開啟歷程檢查狀態變更、執行與同步紀錄。"] },
      { title: "狀態用途", bullets: ["待辦：尚未開始。", "進行中：已有人或 Agent 執行。", "審查：等待 Owner 驗證。", "完成：驗收已通過。"] }
    ],
    relatedArticleIds: ["decision-to-task", "task-agent-execution", "task-evidence-sync"]
  },
  {
    id: "task-agent-execution",
    categoryId: "tasks",
    title: "執行 Agent 顧問或 Agent 產出任務",
    summary: "由 Owner 核准受控 Agent 工作，保存未驗證 Evidence 並限制狀態推進。",
    aliases: ["Task Agent", "Agent Worker", "Agent Advisor"],
    keywords: ["Agent 產出", "顧問", "Worker", "Evidence", "審查"],
    audience: ["Owner", "任務負責人"],
    readMinutes: 5,
    action: { label: "管理任務", href: "/tasks" },
    image: {
      src: "/docs/task-agent.png", width: 1440, height: 900,
      alt: "Council Task Agent 詳情顯示執行方式、Agent、資料邊界與審查狀態",
      caption: "Agent 結果標為未驗證，最多自動移到審查，不會直接完成。"
    },
    sections: [
      { title: "選擇執行方式", bullets: ["人工：由人員完成。", "Agent 顧問：產出建議但不移動 Task。", "Agent 產出：Owner 核准後執行，成功只會自動移到審查。"] },
      { title: "核准與驗證", steps: ["指定已發布且 ready 的 Agent，填寫工作與驗收條件。", "檢查固定的模型、Prompt、Credential revision 與 Skill digest 後核准。", "執行完成後閱讀 Evidence，由人員驗證再決定是否完成。"] }
    ],
    callout: { tone: "warning", title: "Phase 1 權限", body: "Task Agent 不能呼叫 MCP、任意程式、外部寫入，也不能自動標記完成。" },
    relatedArticleIds: ["agent-readiness", "task-evidence-sync", "safety-boundaries"]
  },
  {
    id: "task-evidence-sync",
    categoryId: "tasks",
    title: "查看任務 Evidence、歷程與外部同步",
    summary: "辨識 Agent 輸出、失敗與 Adapter 同步結果，必要時安全重試。",
    aliases: ["Task history", "同步紀錄", "Task Adapter"],
    keywords: ["Evidence", "歷程", "sync", "重試", "external ID"],
    audience: ["Owner", "任務負責人"],
    readMinutes: 4,
    action: { label: "查看任務", href: "/tasks" },
    image: {
      src: "/docs/task-history.jpg", width: 1265, height: 712,
      alt: "Council 任務歷程頁列出建立、更新、狀態變更與同步事件",
      caption: "歷程保留狀態、Adapter 回應與外部 ID，失敗可從原 Task 重試。"
    },
    sections: [
      { title: "閱讀證據", steps: ["開啟 Task 詳情的「證據」，確認來源、時間與未驗證標記。", "切到「歷程」查看狀態、Agent 執行與同步事件。", "外部同步失敗時先修正 Adapter，再從 Task 重試，避免重建資料。"] },
      { title: "可信度", bullets: ["Agent 文字是 inference，不等於已驗證事實。", "Reference Adapter 成功只證明協定與同步邊界。", "最終完成仍由 Owner 依驗收條件判定。"] }
    ],
    relatedArticleIds: ["task-agent-execution", "task-adapters-harness", "decisions-and-evidence"]
  },
  {
    id: "credentials-and-models",
    categoryId: "resources",
    title: "管理 API Key Credential 與雲端／地端模型",
    summary: "把金鑰 metadata、加密 secret 與 OpenAI-compatible Model Connector 分開治理。",
    aliases: ["ＡＰＩ Key", "金鑰", "模型連線", "GB10"],
    keywords: ["API Key", "Credential", "Model Connector", "cloud", "local"],
    audience: ["平台管理員", "Agent 設計者"],
    readMinutes: 5,
    action: { label: "管理連線資源", href: "/settings" },
    image: {
      src: "/docs/settings-registry.png", width: 1440, height: 1000,
      alt: "Council 設定側欄顯示模型與 API 金鑰兩個獨立資源清單",
      caption: "Credential 與 Model Connector 分開，地端 Connector 可明確不需要金鑰。"
    },
    sections: [
      { title: "建立 Credential", steps: ["在設定選 API 金鑰，建立 provider、用途與位置 metadata。", "需要時透過輪替命令提供 secret；讀取畫面只顯示遮罩與 hasSecret。", "不再使用時先停用；確定永久失效再撤銷。"] },
      { title: "連接模型", steps: ["建立 cloud 或 local OpenAI-compatible Connector。", "填寫 base URL 與 model；雲端綁定有效 Credential，地端可不綁。", "通過 health 後啟用，再指派給 Agent 並重新檢查 readiness。"] }
    ],
    callout: { tone: "warning", title: "Secret 不回顯", body: "原文或密文不會出現在 Bootstrap、Prompt preview、Evidence、SSE 或 audit detail。" },
    relatedArticleIds: ["agent-readiness", "prompts-and-skills", "safety-boundaries"]
  },
  {
    id: "prompts-and-skills",
    categoryId: "resources",
    title: "發布 Prompt 並治理 Skill",
    summary: "用不可變 Prompt version 與核准 Skill digest 控制 Agent 指令來源。",
    aliases: ["Prompt 管理", "Skill 管理", "指令版本"],
    keywords: ["Prompt", "Skill", "版本", "publish", "digest"],
    audience: ["Agent 設計者", "平台管理員"],
    readMinutes: 5,
    action: { label: "管理 Prompt 與 Skill", href: "/settings" },
    image: {
      src: "/docs/skill-governance.png", width: 1440, height: 900,
      alt: "Council 設定頁顯示 Skill 版本、來源、人工驗證與核准狀態",
      caption: "Prompt 管完整角色指令；Skill 管可重用且需驗證的專項 instructions。"
    },
    sections: [
      { title: "Prompt 版本", steps: ["建立 Prompt 草稿並使用 allowlist 變數。", "預覽實際組成後發布 v1；後續編輯形成新版本。", "Agent 綁定精確 published version；回復也會建立新的不可變版本。"] },
      { title: "Skill 治理", steps: ["登記名稱、semantic version、instructions、來源與 owner。", "完成人工驗證，確認 content digest 後核准。", "指派給 Agent；內容遭竄改或撤銷時 Worker 會 fail closed。"] }
    ],
    relatedArticleIds: ["agent-create-publish", "agent-readiness", "mcp-readonly-tools"]
  },
  {
    id: "mcp-readonly-tools",
    categoryId: "resources",
    title: "探索並授權唯讀 MCP 工具",
    summary: "以 Connector allowlist、Tool Catalog 與 Agent Grant 三層控制外部工具。",
    aliases: ["ｍｃｐ", "工具管理", "外部函式"],
    keywords: ["MCP", "read-only", "allowlist", "Tool Catalog", "grant"],
    audience: ["平台管理員", "Agent 設計者"],
    readMinutes: 5,
    action: { label: "管理 MCP", href: "/settings" },
    image: {
      src: "/docs/mcp-tools.jpg", width: 1280, height: 800,
      alt: "Council MCP 設定列出 Platform Read-only Connector 與探索命令",
      caption: "探索只登記明確標示 read-only 且非 destructive 的工具。"
    },
    sections: [
      { title: "登記工具", steps: ["建立 MCP Connector，設定端點與必要 token。", "按探索取得工具清單，只核准 readOnlyHint=true 且非 destructive 的項目。", "確認 Tool Catalog 的名稱、版本、owner、目的與 wrapper 類型。"] },
      { title: "授權 Agent", steps: ["在 Agent 草稿加入特定 Connector + tool grant。", "確認 Role policy 也允許唯讀工具，再發布 Agent。", "會中呼叫時系統重驗 allowlist、registration、grant、Role 與 Connector fingerprint。"] }
    ],
    callout: { tone: "warning", title: "拒絕寫入", body: "Phase 1 的寫入型、破壞型或未核准工具一律回覆 TOOL_DENIED。" },
    relatedArticleIds: ["agent-create-publish", "prompts-and-skills", "safety-boundaries"]
  },
  {
    id: "task-adapters-harness",
    categoryId: "resources",
    title: "設定 Task Adapter 與 Harness 邊界",
    summary: "將已核准 Task 同步至固定外部協定，並維持 Harness 預設關閉。",
    aliases: ["外部程式", "任務同步", "Harness Adapter"],
    keywords: ["Task Adapter", "Harness", "外部同步", "health", "allowlist"],
    audience: ["平台管理員", "整合工程師"],
    readMinutes: 4,
    action: { label: "管理執行整合", href: "/settings" },
    image: {
      src: "/docs/task-adapter.jpg", width: 1280, height: 720,
      alt: "Council Task Adapter 設定頁顯示 Reference Adapter 與健康狀態",
      caption: "Reference Adapter 驗證固定同步協定；Harness 僅保留受控 backend 且正式環境關閉。"
    },
    sections: [
      { title: "Task Adapter", steps: ["建立固定 base URL 與 Bearer token 的 Adapter。", "執行 health，確認協定可用後啟用。", "在 Task 選擇 Adapter 並同步；外部 ID 與結果會保留在歷程。"] },
      { title: "Harness", paragraphs: ["Harness Adapter 只允許白名單 Pipeline，正式環境預設關閉。未啟用時執行請求會明確回覆 EXECUTOR_UNAVAILABLE。"] }
    ],
    relatedArticleIds: ["task-evidence-sync", "safety-boundaries"]
  },
  {
    id: "safety-boundaries",
    categoryId: "security",
    title: "理解權限、Secret 與外部執行邊界",
    summary: "確認 Tailnet、Origin、唯讀工具、不可變執行綁定與 Phase 2 非目標。",
    aliases: ["安全性", "權限", "Secret", "Phase 2"],
    keywords: ["Tailnet", "Origin", "MCP", "secret", "fail closed"],
    audience: ["Owner", "平台管理員", "安全審查者"],
    readMinutes: 5,
    action: { label: "檢查設定", href: "/settings" },
    image: {
      src: "/docs/settings-registry.png", width: 1440, height: 1000,
      alt: "Council 設定頁將治理資源、連線工具與執行整合分組",
      caption: "權限來自 Registry、Role、Agent grant 與 runtime 重驗，不來自顯示文字。"
    },
    sections: [
      { title: "目前控制", bullets: ["Gateway 只綁外部主機 loopback，使用 Tailnet HTTPS。", "缺少或外來 Origin 會被拒絕。", "Secret 加密保存且不進 Prompt、Evidence、SSE 或 audit detail。", "模型、Prompt、Credential、Skill、Role 或工具漂移時，舊工作不能提交。"] },
      { title: "使用者檢查", steps: ["只核准必要的 Role、Skill、Connector 與唯讀 Tool Grant。", "發布或輪替後重新檢查 Agent readiness 與 Effective Configuration。", "遇到 blocked 或 stale 結果時修正資源後重試，不降低安全條件。"] }
    ],
    callout: { tone: "warning", title: "尚未提供", body: "Agent Pod、OpenAB Broker、任意 shell/library、寫入型 MCP、完整關係圖與多租戶 RBAC 仍是 Phase 2。" },
    relatedArticleIds: ["credentials-and-models", "mcp-readonly-tools", "recovery-and-failures"]
  },
  {
    id: "recovery-and-failures",
    categoryId: "security",
    title: "處理模型、Worker、MCP 故障與平台復原",
    summary: "故障時先保留狀態與證據，再依既有 release、備份與 restore gate 復原。",
    aliases: ["故障排除", "備份還原", "rollback"],
    keywords: ["pause", "failure evidence", "backup", "restore", "rollback"],
    audience: ["Owner", "平台維運者"],
    readMinutes: 6,
    action: { label: "查看討論狀態", href: "/" },
    image: {
      src: "/docs/platform-overview.png", width: 1440, height: 900,
      alt: "Council 討論頁保留會議逐字稿、狀態、決議與任務關係",
      caption: "執行故障會保存 Meeting 或 Task 狀態與 failure evidence，便於重試與稽核。"
    },
    sections: [
      { title: "產品內處理", steps: ["模型或 MCP 失敗時查看 failure 訊息與 Evidence，確認 Meeting 是否暫停。", "修正 Connector、Credential、Skill 或工具狀態，再從原操作重試。", "不要刪除 Meeting 或 Task；保留來源、歷程與 audit。"] },
      { title: "平台復原", bullets: ["正式資料只在自架 PostgreSQL 與受控目錄。", "部署前後建立版本化備份，還原需通過 migration、核心資料與 API bootstrap gate。", "回滾停止新 release 但不刪除 Volume，不 prune、不改防火牆、不操作其他 Stack。"] }
    ],
    callout: { tone: "info", title: "先 forward-fix", body: "若上一版含已知資料或生命週期缺陷，優先修正新版，不把缺陷重新帶回正式環境。" },
    relatedArticleIds: ["safety-boundaries", "task-evidence-sync"]
  }
];

function normalizeSearch(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase("zh-Hant").trim().replace(/\s+/g, " ");
}

function articleSearchFields(article: DocumentationArticle) {
  return {
    title: normalizeSearch(article.title),
    aliases: article.aliases.map(normalizeSearch),
    keywords: article.keywords.map(normalizeSearch),
    summary: normalizeSearch(article.summary),
    sections: article.sections.flatMap((section) => [
      section.title,
      ...(section.paragraphs ?? []),
      ...(section.steps ?? []),
      ...(section.bullets ?? [])
    ]).map(normalizeSearch),
    callout: article.callout ? normalizeSearch(`${article.callout.title} ${article.callout.body}`) : ""
  };
}

function scoreArticle(article: DocumentationArticle, query: string) {
  const fields = articleSearchFields(article);
  let score = 0;
  if (fields.title === query) score += 140;
  else if (fields.title.includes(query)) score += 100;
  if (fields.aliases.some((value) => value === query)) score += 90;
  else if (fields.aliases.some((value) => value.includes(query))) score += 65;
  if (fields.keywords.some((value) => value === query)) score += 80;
  else if (fields.keywords.some((value) => value.includes(query))) score += 55;
  if (fields.summary.includes(query)) score += 40;
  score += Math.min(30, fields.sections.filter((value) => value.includes(query)).length * 10);
  if (fields.callout.includes(query)) score += 8;
  return score;
}

export function searchDocumentationArticles(query: string, categoryId?: DocumentationCategoryId) {
  const normalized = normalizeSearch(query);
  const candidates = documentationArticles.filter((article) => !categoryId || article.categoryId === categoryId);
  if (!normalized) return candidates;

  return candidates
    .map((article, index) => ({ article, index, score: scoreArticle(article, normalized) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((entry) => entry.article);
}

export function getDocumentationArticle(id: string) {
  return documentationArticles.find((article) => article.id === id) ?? null;
}
