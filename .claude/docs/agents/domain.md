# Domain 文件

engineering skill 在探索 codebase 時，應如何讀取這個 repo 的 domain 文件。

這個 repo 所有給 AI 看的文件都放在 `.claude/docs/` 底下。

## 探索前先讀這些

- **`.claude/docs/CONTEXT.md`**，或
- **`.claude/docs/CONTEXT-MAP.md`**（若存在）— 它會指向每個 context 各自的 `CONTEXT.md`，讀取與主題相關的那幾份。
- **`.claude/docs/adr/`** — 讀取與你即將動工的區域相關的 ADR。

若這些檔案不存在，**安靜地繼續**。不要特別指出它們不存在，也不要一開始就建議建立。`/domain-modeling` skill（透過 `/grill-with-docs` 和 `/improve-codebase-architecture` 觸發）會在術語或決策實際被釐清時才順手建立。

## 檔案結構

單一 context 的 repo（本 repo）：

```
/
└── .claude/docs/
    ├── CONTEXT.md
    └── adr/
        ├── 0001-example-decision.md
        └── 0002-another-decision.md
```

多 context 的 repo（存在 `.claude/docs/CONTEXT-MAP.md`）：

```
/
└── .claude/docs/
    ├── CONTEXT-MAP.md
    ├── adr/                       ← 系統層級的決策
    └── contexts/
        ├── ordering/
        │   ├── CONTEXT.md
        │   └── adr/               ← 該 context 專屬的決策
        └── billing/
            ├── CONTEXT.md
            └── adr/
```

## 使用詞彙表的用語

當你的產出提到某個 domain 概念（issue 標題、重構提案、假設、測試名稱），使用 `CONTEXT.md` 定義的用語。不要漂移到詞彙表明確避免的同義詞。

若你需要的概念還不在詞彙表裡，這是個訊號 — 要嘛你在發明專案沒在用的語言（重新考慮），要嘛是真的有缺口（記下來給 `/domain-modeling`）。

## 標示 ADR 衝突

若你的產出和既有的 ADR 矛盾，明確點出來，不要默默覆蓋：

> _與 ADR-0007（event-sourced orders）矛盾 — 但值得重新討論，因為……_
