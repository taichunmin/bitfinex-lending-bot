# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 語言

- 與使用者互動一律使用繁體中文（台灣用語）。
- 專案文件（`.claude/docs/`、`docs/`、`.scratch/`、`CONTEXT.md`、ADR 等）以繁體中文撰寫。
- 保留不翻譯的字面值：程式碼、識別字、沒有合適中文翻譯的專有名詞、路徑、檔名、CLI 指令、標籤字串（如 `needs-triage`）、欄位名（如 `Status:`）、以及 skill 內文會比對的英文片語。

## 專案用途

Bitfinex 融資（放貸）自動化機器人。核心是 `bin/` 底下多支獨立的 TypeScript 腳本，透過 GitHub Actions 定時執行：自動調整 auto-renew 出借利率、匯出歷史借出記錄、計算年化績效，並把結果部署到 GitHub Pages、用 Telegram 回報。

## 常用指令

- `yarn` — 安裝依賴（專案用 yarn，CI 也是）
- `yarn lint` — ESLint 檢查並自動修正（CI 會跑，未過會失敗）
- `yarn test` — Jest（目前尚無測試檔）
- `yarn repl` — 開啟預載 Bitfinex client 的 Node REPL，用來手動打 API
- `yarn tsx ./bin/<script>.ts` — 直接執行單一腳本（不需編譯；每支檔案開頭註解有所需環境變數）

## 架構重點

- **執行方式**：腳本用 `tsx` 直接跑，無 build 步驟。每支 `bin/` 檔案是獨立進入點，結尾會判斷是否為主模組再自我執行。`dist/` 只是腳本產出的靜態檔（gitignore），供 GitHub Pages 部署。
- **設定來源**：全部靠環境變數（`INPUT_*`、`BITFINEX_*`、`TELEGRAM_*`），本地放 `.env`（見 `.env.example`），CI 放 workflow env 與 secrets。字串內容多為 YAML／JSON5，進來後用 zod schema 驗證。
- **匯入順序**：任何檔案都要先 `import '@/lib/dotenv'`（或間接引入 `getenv`）再引其他模組，確保環境變數先載入。`@/*` 路徑別名對應專案根目錄。
- **狀態持久化**：跨執行的狀態（例如已發送的 Telegram 訊息 id）存在 Bitfinex 帳號的 user settings，key 為 `api:taichunmin_<檔名>`，非本地檔案。
- **兩套 Bitfinex client**：新腳本用 `@taichunmin/bitfinex`（`Bitfinex` class）；`lib/bitfinex.ts` 是包在舊版 `bitfinex-api-node` 上的薄層，逐步淘汰中。
- **funding-auto-renew-N**：自動放貸機器人，`-1`/`-2`/`-3` 是同一支機器人的演進版本，數字越大越新；目前實際使用 `-3`（見 CI），`-1`/`-2` 只是舊計算方式的備份，不再執行。`-2`/`-3` 的利率邏輯：抓過去一天的 1 分鐘 K 線，加總成交量，用二分搜尋找出成交量落在目標分位（`rank`）的利率，再用 `rateMin`/`rateMax` 夾住，最後依 `period` 對照表換算出借天數。
- **funding-statistics-1**：計算放貸收益（昨日／7 日／30 日年化），結果傳 Telegram，並把 CSV 輸出到 `dist/` 部署上 GitHub Pages，供 Looker Studio（前 Data Studio）讀取做報表：<https://datastudio.google.com/reporting/500aadf5-8d0d-4cba-a1ce-7275c7e5b21e>
- **lib/**：`logger` 產生以 `debug` 為底、輸出 YAML 的 logger 群組並會遮蔽敏感欄位；`helper` 是數字／日期／百分比格式化；`telegram` 走 Bot API 發送與編輯訊息；`gcs`／`github-gist` 為選用的匯出目標。

## GitHub Actions

- `taichunmin-funding-auto-renew-3.yml` — 每 10 分鐘跑 `funding-auto-renew-3.ts`，調整出借利率。
- `gh-pages.yml` — 定時執行 `funding-export-credits-1.ts` 與 `funding-statistics-1.ts`，產出 `dist/` 後部署到 GitHub Pages。
- 兩者都有 `if: github.repository_owner == 'taichunmin'`，fork 後需改成自己的帳號。

## Agent skills

### Issue tracker

Issues 和 specs 以 markdown 檔存放在 `.scratch/<feature-slug>/`。詳見 `.claude/docs/agents/issue-tracker.md`。

### Triage labels

使用五個標準標籤（`needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix`），記錄在每個 issue 檔案的 `Status:` 行。詳見 `.claude/docs/agents/triage-labels.md`。

### Domain docs

單一 context — `.claude/docs/CONTEXT.md` + `.claude/docs/adr/`。詳見 `.claude/docs/agents/domain.md`。
