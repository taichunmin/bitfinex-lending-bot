# 放貸／投資績效報告：指標設計與 Looker Studio 串接規劃

> 研究日期：2026-08-30
> 對象腳本：`bin/funding-statistics-1.ts`、`bin/funding-export-credits-1.ts`
> 目標：在既有實作上擴充績效報告的數據指標，並規劃 JSON／CSV 輸出格式供 Looker Studio 製作報表。

---

## 1. 摘要

現有 `funding-statistics-1` 已經產出一張「每日一列」的寬表（`date, interest, apr1/7/30/365, balance, dpr, investment, lentRatio1/7/30/365`），部署到 GitHub Pages 供 Looker Studio 讀取。它的核心缺口有三個：

1. **報酬率口徑不符合業界慣例。** `apr*` 是「每日 `dpr×365` 的 trailing N 日**算術**平均」，既非時間加權報酬（TWR）的幾何連乘，也違反 GIPS「未滿一年不得年化」的規定（來源：<https://www.cfainstitute.org/insights/professional-learning/refresher-readings/2026/overview-of-the-global-investment-performance-standards>）。應補一組幾何連乘的累積報酬與（僅對 ≥1 年期）幾何年化。
2. **完全沒有風險指標。** 沒有淨值曲線、最大回撤、報酬波動度、Sharpe／Sortino。放貸雖然波動小，但利率會隨行情大幅跳動，且有「閒置沒借出去」的隱性成本，值得量化。
3. **沒有 benchmark。** Bitfinex 自己就提供 funding 市場的 FRR（Flash Return Rate）與市場資金使用率，是現成、免費、同幣別的對標基準（來源：<https://docs.bitfinex.com/reference/rest-public-funding-stats>）。

此外，入金／出金會讓 `dpr`、`investment`、`lentRatio*` 在當天短暫失真（`lentRatio` 的部分已在 ADR-0001 記錄並選擇不修正）。「開帳以來」這個總報酬數字應改用資金加權報酬（MWR／XIRR）才能正確處理現金流。

本文件盤點現有實作、逐項研究指標與公式（附一手來源）、規劃 Looker Studio 串接，最後給出**建議欄位清單**、**JSON/CSV 結構建議**、**`tplStat()` 擴充介面草稿**與**分階段落地建議**。

---

## 2. 現有實作盤點

### 2.1 `bin/funding-statistics-1.ts`

**資料來源（Bitfinex API，透過 `@taichunmin/bitfinex`）：**

| 呼叫 | 用途 |
| --- | --- |
| `Bitfinex.v2PlatformStatus()` | 維護模式檢查 |
| `bitfinex.v2AuthReadFundingCredits()` | 進行中（ACTIVE）的出借，供 `lentRatio` 計算把「執行當下還開著的單」併入昨天 |
| `bitfinex.v2AuthReadLedgersHist({ category: MarginSwapInterestPayment /* 28 */, currency, limit: 2500 })` | 利息 payout 分類帳（只留 `wallet === 'funding'`），是所有 `interest`／`dpr`／`apr*` 的來源 |
| `bitfinex.v2AuthReadSettings` / `v2AuthWriteSettingsSet`（key `api:taichunmin_funding-statistics-1`） | 記住「上次已發送 Telegram 的最新日期」`latestDate2[currency]` |

**逐日計算（`stats[date]`，`tplStat()` 產生一列）：**

- `interest`：當日 category 28 payout 金額加總（`payment.amount`）。
- `balance`：當日 payout 後帳戶餘額的最大值（`Math.max(..., payment.balance)`）。
- `investment` = `round(balance − interest, 8)`：當日「可投入本金」＝餘額扣掉當天剛入帳的利息；約等於前一經濟日結束的本金（見 CONTEXT.md「可投入本金」詞條）。
- `dpr` = `interest × 100 / investment`（`investment ≤ 0` 時為 0）：**當日利息 ÷ 當日起始本金**，單位是百分比數值（不是比率）。
- `apr1` = `dpr × 365`：當日日報酬**算術**年化。
- `apr7 / apr30 / apr365`：把每一天的 `apr1` 往後灑到未來 N 天累加，最後除以 N ⇒ **trailing N 日 `apr1` 的算術平均**（`i < 7` / `i < 30` / 全 365）。缺資料的日子 `apr1 = 0`，會把平均拉低。
- `lentRatio1` = `100 × lentAmountByDay / investment`：單日時間加權放出金額 ÷ 當日起始本金。
- `lentRatio7 / 30 / 365`：trailing N 日 `Σ每日放出金額 ÷ Σ每日 investment`（用前綴和加速），**時間加權，不夾 100%**。完整口徑見 `.claude/docs/adr/0001-lent-ratio-calculation.md`。

**`calcLentAmountByDate()`：** 把每筆出借金額依存續時間（`[openedAt, closedAt]`）攤到每個 UTC 日。已關閉的單讀自 `funding-export-credits-1` 匯出的 `dist/funding-export-credits-1/<CURRENCY>.csv`（依 `id` 去重），ACTIVE 的單以 `[mtsOpening, 現在]` 併入、不落地。

**輸出：**

- `dist/funding-statistics-1/<CURRENCY>.json` — `JSON.stringify(_.values(stats), null, 2)`，即「每日一物件」的陣列。
- `dist/funding-statistics-1/<CURRENCY>.csv` — `Papa.unparse(_.values(stats), { header: true })`，寬表。
- Telegram 每日報告（僅當 `dateMax` 比上次新）：日期、利息、`1/7/30/365日年化: X% (利用率 Y%)`。年化取 `stats[dateMax]`，利用率取 `stats[dateMax−1]`（ADR-0001 決策 4）。

**部署：** `.github/workflows/gh-pages.yml` 每天 UTC 00:45／01:45／02:45／03:45 跑 `funding-export-credits-1` + `funding-statistics-1`，把整個 `dist/` 傳上 GitHub Pages。Looker Studio 報表：<https://datastudio.google.com/reporting/500aadf5-8d0d-4cba-a1ce-7275c7e5b21e>。

### 2.2 `bin/funding-export-credits-1.ts`

用 `bitfinex.v2AuthReadFundingCreditsHist({ limit: 500, end })` 反覆往前分頁（`end = min(mtsUpdate)`），直到某頁不滿 500 筆。每筆取 `id, amount, period, rate, side, status` + `openedAt(mtsOpening), closedAt(mtsLastPayout), createdAt(mtsCreate), updatedAt(mtsUpdate)`（皆 `YYYY-MM-DD HH:mm:ss` UTC 字串）。輸出 `dist/funding-export-credits-1/<CURRENCY>.csv`。

- 註解裡有一段手動上傳 GCS 的指令（`gs://storage-taichunmin.taichunmin.idv.tw/bitfinex-funding-credits-1`）與 `lib/gcs.ts` 的 `uploadCsv()`，但 workflow 目前只走 GitHub Pages，GCS 上傳是選用。
- 去重只比對「相鄰前一筆 `id`」，分頁重疊 + 多幣別交錯會漏，CSV 偶有重複列（ADR-0001 決策 5，`funding-statistics-1` 讀檔時用 `Set<id>` 補擋）。

### 2.3 `bin/funding-auto-renew-3.ts`（利率如何決定，供理解 benchmark）

抓過去一天 `f<CURRENCY>` 的 1 分鐘 K 線（`Bitfinex.v2CandlesHist`，`aggregation: 30, periodStart: 2, periodEnd: 30`），把成交量加總，用二分搜尋找出成交量落在 `rank` 分位的利率（`calcTargetRate()`，純函式），用 `rateMin`／`rateMax` 夾住，再依 `period` 對照表換算天期（`rateToPeriod()`）。也會抓 `Bitfinex.v2FundingStatsHist({ currency, limit: 1 })` 拿當前 FRR 記進 log（但沒有存進報告）。

### 2.4 可用相依（`package.json`）

`@taichunmin/bitfinex@0.0.15`、`dayjs`（`lib/dayjs` 已載 `utc` plugin）、`lodash`、`papaparse`、`zod@4`、`js-yaml`、`json5`、`technicalindicators`、`@google-cloud/storage`、`octokit`。測試用 `vitest`。無 build 步驟，`tsx` 直接跑。

### 2.5 `@taichunmin/bitfinex` 可用且尚未使用的方法（重點）

| 方法 | 回傳（重點欄位） | 對報告的價值 |
| --- | --- | --- |
| `bitfinex.v2AuthReadInfoFunding({ currency })` | `yieldLend`（提供方資金的**加權平均利率**）、`yieldLoan`、`durationLend`（提供方資金的**加權平均天期**）、`durationLoan` | 直接給「加權平均出借利率／天期」，免自己從 credits 算（來源：<https://docs.bitfinex.com/reference/rest-auth-info-funding>） |
| `bitfinex.v2AuthReadWallets()` | 每個錢包的 `balance`、`availableBalance`、`unsettledInterest` | `funding` 錢包的即時餘額 / 可用餘額 / 未結利息；`balance − availableBalance` ≈ 已借出+掛單 |
| `bitfinex.v2AuthReadFundingTradesHist({ currency, start, end, limit })` | 每筆成交出借：`id, mtsCreate, amount, rate, period` | 逐筆利率／天期分布、加權平均、當期新承作金額 |
| `bitfinex.v2AuthReadFundingOffers({ currency })` | 掛單中未成交的 offer：`amount, rate, period` | 「掛單中閒置」金額，算真實 idle |
| `Bitfinex.v2FundingStatsHist({ currency, start, end, limit≤250 })` | 逐時間點：`frr`（已 ×365）、`apr`（已 ×365×365）、`avgPeriod`、`amount`（市場總放款）、`amountUsed`（被部位使用）、`belowThreshold` | **benchmark**：市場 FRR、市場平均天期、市場資金使用率 `amountUsed/amount`（來源：<https://docs.bitfinex.com/reference/rest-public-funding-stats>） |
| `bitfinex.v2AuthReadLedgersHist({ category, currency })` | `id, currency, wallet, mts, amount, balance, description` | category `51`=Transfer、`101`=Deposit、`104`=Withdrawal ⇒ 偵測 funding 錢包的**外部現金流**；category `28`=利息（現用） |
| `Bitfinex.v2CandlesHist({ currency, timeframe, periodStart, periodEnd, aggregation })` | funding 蠟燭 `MTS/OPEN/CLOSE/HIGH/LOW/VOLUME` | 已用於 auto-renew；也可算「市場利率波動度」當風險對照 |

（`LedgersHistCategory` 值來源：`node_modules/@taichunmin/bitfinex` enums、`js-bitfinex/src/enums.ts`；`MarginSwapInterestPayment = 28`、`Transfer = 51`、`Deposit = 101`、`Withdrawal = 104`。官方分類表：<https://docs.bitfinex.com/reference/rest-auth-ledgers>）

---

## 3. 指標研究

> 慣例：報酬率以「小數比率」為內部單位（0.001 = 0.1%），輸出欄位若沿用現有 `dpr`／`apr*` 的「百分比數值」慣例會在表格標註。所有「日」以 UTC 日界切分，與現有程式一致。

### 3.1 報酬率口徑

#### 3.1.1 Time-Weighted Return (TWR) vs Money-Weighted Return (MWR / IRR / XIRR)

- **TWR** 消除出入金時點與金額對報酬率的影響，衡量「策略／操盤本身」的表現；做法是把期間依每次外部現金流切成子期間，各子期間報酬率**幾何連乘**：`(1+r_1)(1+r_2)…(1+r_n) − 1`。
- **MWR** 就是使這串現金流 NPV = 0 的內部報酬率（不等間距時即 XIRR），反映「投資人實際口袋的報酬」，受出入金時點影響。
- **GIPS 規定**：對客戶掌控現金流時點的情況，**必須用 TWR**；只有在「公司掌控外部現金流，且投資組合為封閉式／固定壽命／固定承諾／策略含重大流動性不足資產」時才**允許**改用 MWR（來源：<https://www.cfainstitute.org/insights/professional-learning/refresher-readings/2026/overview-of-the-global-investment-performance-standards>）。
- **對本專案**：使用者自己就是投資人，會不定期入金／出金。
  - 「策略打得好不好」→ 用 **TWR**（子期間切在每天，或切在每次 category 51/101/104 現金流）。
  - 「我這筆錢實際年化多少」→ 用 **XIRR**（現金流＝每次入金為負、出金為正、期末淨值為正）。
  - 兩個都該出，分別標為「報酬率（TWR）」與「個人年化（XIRR）」。

#### 3.1.2 年化方法：幾何 vs 算術

- 幾何年化：`(1 + r_period)^(365/n) − 1`；算術年化：`r_period × 365/n`。
- 放貸利息每天 payout 且會複利（payout 落回 funding 錢包、隔天成為本金的一部分，見 `investment = balance − interest` 的推導），因此**幾何**才反映實際成長；算術會低估。差距在低利率、短期時很小，但在 30/365 日尺度、利率 15%+ 時明顯。
- **GIPS**：「未滿一年的報酬不得年化」（來源：同上 CFA Institute refresher）。因此 `apr1`／`apr7`／`apr30` 嚴格說不該叫「年化」，應改為輸出「當期實際報酬率」`return1/7/30`，年化只保留 `apr365`（或 ITD 幾何年化）。若要保留短期年化給直覺，欄位命名與圖表標題要標「annualized, indicative」。

#### 3.1.3 APR vs APY（複利）

- APR＝不計複利的名目年利率＝`日利率 × 365`（Bitfinex 掛單利率的呈現方式，`rate × 365`）。
- APY＝計入複利＝`(1 + 日利率)^365 − 1`。Bitfinex funding stats 的 `apr` 欄其實是 `frrDiv365 × 365 × 365`（即日利率×365×365），是「日利率的日複利近似」而非嚴謹 APY（來源：<https://docs.bitfinex.com/reference/rest-public-funding-stats>，原文：「To get APR as percentage use rate x 100 x 365 x 365」）。
- **報告應同時給** `aprGross`（名目，可跨天期比較、跟掛單利率對得上）與 `apyNet`（實際複利成長，跟淨值曲線對得上）。

#### 3.1.4 現有 `apr*`（每日年化的簡單平均）與標準 TWR 的差異

| 面向 | 現有 `apr7/30/365` | 標準 TWR（trailing N 日） |
| --- | --- | --- |
| 連結方式 | 算術平均 `mean(apr1_d)` | 幾何連乘 `∏(1 + dpr_d/100) − 1` |
| 缺資料日 | 當 `apr1 = 0` 拉低平均 | 該日子期間報酬 0，連乘不失真（只是那天沒賺） |
| 本金變動 | 每天等權，忽略當天本金大小 | 每天以「當天報酬率」進入，天然按時間加權 |
| 年化 | 一律 ×365（違反 GIPS 短期不年化） | 只對 ≥1 年期做 `^(365/n)` |
| 複利 | 無 | 有 |

**結論**：應**新增**一組 `twrRet{1,7,30,365}`（trailing N 日幾何累積報酬，不年化）與 `twrAprGeo365`（僅 365 日幾何年化）；`apr*` 可保留為「indicative annualized」但在文件與圖上明講其為算術近似。

### 3.2 風險與品質指標

#### 3.2.1 最大回撤（Max Drawdown, MDD）與回撤持續期

- 需先有**淨值曲線** `equity_d`（把每天 TWR 子期間報酬連乘成指數，起點 1.0，或用實際本金曲線扣掉現金流）。
- `drawdown_d = equity_d / max(equity_{≤d}) − 1`（≤ 0）。
- `maxDrawdown = min_d(drawdown_d)`；回撤持續期＝從前高到回到前高的天數。
- 放貸的回撤幾乎只來自「利率驟降時實際報酬 < 前期」造成的淨值成長趨緩，理論上淨值單調遞增（利息不會是負的，除非有費用），所以更該看的是**「相對高水位的成長停滯天數」**與**「日報酬掉到多低」**，而不是傳統 MDD。仍建議輸出 `maxDrawdown`／`drawdownDays` 以符合報表慣例，多半會接近 0，本身就是一個賣點。
- 定義參考：CFA Institute《Overview of the GIPS Standards》及一般 GIPS 附加資訊（來源：<https://www.cfainstitute.org/insights/professional-learning/refresher-readings/2026/overview-of-the-global-investment-performance-standards>）。

#### 3.2.2 報酬波動度

- 日報酬序列 `dpr_d/100`（或 TWR 子期間報酬）。
- `volDaily = stdev(dpr_d/100)`（樣本標準差）；`volAnnual = volDaily × sqrt(365)`。
- 放貸日報酬波動主要來自「當天有沒有滿倉、利率跳動、有沒有大額入金稀釋」。

#### 3.2.3 風險調整後報酬

- **Sharpe ratio** = `(R_p − R_f) / σ_p`（年化基礎）。`R_f` 取無風險利率——對 USD／UST 放貸，最合理的是**美國國庫券短率**或直接取 0（保守）。也可取「若不放貸、只擺在交易所」＝0。建議欄位存兩版：`sharpeVsZero`、`sharpeVsFrr`（以市場 FRR 當機會成本）。
- **Sortino ratio** = `(R_p − MAR) / DD`，`DD`＝只計低於 MAR 的報酬的下方標準差（Lower Partial Standard Deviation）。`MAR`（最低可接受報酬）建議取市場 FRR 或一個固定門檻（例如 APR 5%）。Sortino 由 Frank A. Sortino 於 1980 年代提出，用 MAR 取代 Sharpe 的無風險利率、只懲罰下方波動（來源：<https://www.cfainstitute.org/insights/professional-learning/refresher-readings/2026/overview-of-the-global-investment-performance-standards>；概念說明：<https://www.schwab.com/learn/story/using-sortino-ratio-to-gauge-downside-risk>）。
- 放貸情境下 Sortino 通常遠高於 Sharpe（下方波動極小），是很好的行銷數字，但要註明樣本天數，天數太少（< 30）不穩定。

#### 3.2.4 放貸特有指標

| 指標 | 定義 | 來源 |
| --- | --- | --- |
| `rateWeightedAvg` | 加權平均出借利率 = `Σ(amount_i × rate_i) / Σ amount_i`；或直接取 API `yieldLend` | `v2AuthReadInfoFunding.yieldLend` / credits CSV |
| `periodWeightedAvg` | 加權平均天期 = `Σ(amount_i × period_i) / Σ amount_i`；或 API `durationLend` | `v2AuthReadInfoFunding.durationLend` / credits CSV |
| `rateP25 / rateMedian / rateP75` | 當期新承作出借利率的分位數（看利率分散度） | `v2AuthReadFundingTradesHist` |
| `idleRatio` | `1 − lentRatio`（未出借閒置比例） | 現有 `lentRatio` |
| `idleDays` | trailing N 日 `Σ(每日閒置本金 / investment)`，即「等效閒置天數」 | 現有前綴和 |
| `offerPendingRatio` | 掛單中未成交金額 / investment（閒置中「有在努力」的部分） | `v2AuthReadFundingOffers` |
| `frrGap` | `rateWeightedAvg − frrMarket`（自己借得比市場好／差多少） | 兩者相減 |

### 3.3 部位／活動指標

- **資金利用率**：現有 `lentRatio*`。業界對應詞是 utilization rate / deployment rate / capital-at-work。Bitfinex 市場自己的使用率＝`amountUsed / amount`（來源：<https://docs.bitfinex.com/reference/rest-public-funding-stats>），可當 `lentRatioMarket` 對照——注意口徑不同：我方 `lentRatio` 是「已放出/可投入」，市場的是「已被部位借走/總放款」。
- **本金成長曲線 / 累積利息 / 淨值**：
  - `interestCum` = 開帳至該日累積利息。
  - `equity` = 淨值指數（起點 1.0，每日 `× (1 + dpr_d/100)`）——這是 TWR 的圖形化。
  - `principal` = 實際本金曲線（`investment`，含入金跳階）。
- **出借活動**：
  - `creditsOpenCount` / `creditsOpenAmount`：當日進行中出借筆數／金額。
  - `creditsNewCount` / `creditsNewAmount`：當日新承作（`v2AuthReadFundingTradesHist`）。
  - `avgTicket` = `creditsOpenAmount / creditsOpenCount`。
  - `renewRate` = 到期後被自動續借（`renew = true` 且緊接新單）比例——資料上較難精算，可近似為「到期單裡 `renew` 旗標為真的比例」。
  - `defaultCount` / `forcedCloseCount`：`status` 非 `CLOSED (expired)` 的關閉筆數（例如被部位提前平倉）。從 `funding-export-credits-1` 的 `status` 欄統計。
- **現金流與績效歸因**：
  - `netFlow_d` = 當日 category 101 Deposit + 51 Transfer(進) − 104 Withdrawal − 51 Transfer(出)，限 `wallet = 'funding'`。
  - 有了 `netFlow_d` 就能：(a) 正確算 XIRR；(b) 標記「當日利用率／dpr 因入金而失真」；(c) 把「本金成長」拆成「利息累積貢獻」vs「外部注資貢獻」。

### 3.4 報表呈現慣例

- **期間報酬表**：MTD / QTD / YTD / 1M / 3M / 1Y / **ITD（since inception，開帳以來）**。每格給「累積報酬（TWR）」＋（≥1 年才給）「年化」。ITD 另給 XIRR。
- **滾動報酬（rolling returns）**：trailing 7 / 30 / 90 / 365 日 TWR，逐日一點，畫成折線看穩定度。現有 `apr7/30/365` 就是這個的算術版，改成幾何即可。
- **Benchmark 比較**：
  - 主基準：同幣別 Bitfinex **FRR**（`v2FundingStatsHist.frr`，已 ×365 的日利率年化；或用 `apr` 欄）。
  - 輔助：市場 `avgPeriod`、市場使用率 `amountUsed/amount`。
  - 輸出 `frrMarket`、`aprMarket`、`excessReturn = twrRet − frrReturn`（同視窗）。
- GIPS 一般規定「報酬須扣除交易成本後計算」（來源：<https://www.cfainstitute.org/insights/professional-learning/refresher-readings/2026/overview-of-the-global-investment-performance-standards>）。放貸這邊 Bitfinex 收 15% 利息分成，且已在 payout 金額中扣掉（category 28 的 `amount` 是淨額），所以現有 `interest` 已是 net——文件註明即可。

### 3.5 Bitfinex 官方 API 能提供什麼（一手查證）

| 需求 | Endpoint | 重點 |
| --- | --- | --- |
| 市場 FRR / 平均天期 / 使用率（benchmark） | `GET v2/funding/stats/f<CCY>/hist`（`Bitfinex.v2FundingStatsHist`） | 回傳陣列位置：`[0]MTS, [3]FRR(=1/365 FRR), [4]AVG_PERIOD, [7]FUNDING_AMOUNT, [8]FUNDING_AMOUNT_USED, [11]FUNDING_BELOW_THRESHOLD`。FRR→日利率：`×365`；→APR%：`×100×365×365`。`limit ≤ 250`。（<https://docs.bitfinex.com/reference/rest-public-funding-stats>） |
| 利息收入明細 | `GET v2/auth/r/ledgers/<CCY>/hist`（`v2AuthReadLedgersHist`） | `category` filter，`28` = margin/swap/interest payment（利息收入）。其他相關：`27` position funding cost（借入成本，本專案不適用）、`29` derivatives funding。回傳 `[0]ID,[1]CCY,[2]WALLET,[3]MTS,[5]AMOUNT,[6]BALANCE,[8]DESCRIPTION`。`limit ≤ 2500`，最多回溯 6 年。（<https://docs.bitfinex.com/reference/rest-auth-ledgers>） |
| 外部現金流 | 同上，`category` = `51`(Transfer) / `101`(Deposit) / `104`(Withdrawal) | 需自己 filter `wallet = 'funding'` |
| 逐筆出借成交 | `GET v2/auth/r/funding/trades/f<CCY>/hist`（`v2AuthReadFundingTradesHist`） | `[0]ID,[1]SYMBOL,[2]MTS_CREATE,[3]OFFER_ID,[4]AMOUNT,[5]RATE,[6]PERIOD`。`start`/`end`/`limit` 分頁。（<https://docs.bitfinex.com/reference/rest-auth-funding-trades-hist>） |
| 已結束出借 | `GET v2/auth/r/funding/credits/f<CCY>/hist`（`v2AuthReadFundingCreditsHist`） | 現用於 `funding-export-credits-1`；`limit ≤ 500`，用 `end` 對 `mtsUpdate` 分頁。（<https://docs.bitfinex.com/reference/rest-auth-funding-credits-hist>） |
| 進行中出借 | `GET v2/auth/r/funding/credits/f<CCY>`（`v2AuthReadFundingCredits`） | 現用於 `lentRatio` |
| 加權平均利率／天期 | `GET v2/auth/r/info/funding/f<CCY>`（`v2AuthReadInfoFunding`） | `YIELD_LEND`、`DURATION_LEND` 為「提供方」的加權平均。（<https://docs.bitfinex.com/reference/rest-auth-info-funding>） |
| 錢包餘額 | `GET v2/auth/r/wallets`（`v2AuthReadWallets`） | `balance` / `availableBalance` / `unsettledInterest` |
| funding 蠟燭（市場利率波動） | `GET v2/candles/trade:<TF>:f<CCY>:a30:p2:p30/hist`（`Bitfinex.v2CandlesHist`） | `MTS/OPEN/CLOSE/HIGH/LOW/VOLUME`，`limit ≤ 10000`，30 reqs/min。（<https://docs.bitfinex.com/reference/rest-public-candles>） |

**分頁上限備忘**：ledgers 2500／credits-hist 500／funding-stats 250／candles 10000。歷史回填時都要迴圈分頁（`funding-export-credits-1` 已示範 credits 的作法）。

---

## 4. Looker Studio 資料串接規劃

### 4.1 CSV 當資料來源的限制（一手：Google Cloud / Looker 文件）

- **檔案上傳（File upload connector）**：單一 dataset ≤ **100 MB**，每位使用者總儲存 **2 GB**、**1000 個 dataset**、每個 dataset **每天 100 次上傳**。同一 dataset 每次上傳的檔案**結構必須完全相同（欄位、順序一致）**；新檔案是 **append 不是 merge**，重複列不會自動去除。必須 **UTF-8**、每列欄數一致（缺值也要留空欄）。欄名只能英數與底線、開頭為字母或底線、≤ 128 字元、不可重複。（來源：<https://docs.cloud.google.com/looker/docs/studio/upload-csv-files-to-looker-studio>）
- **日期格式**：CSV 上傳常見問題是「日期／數字被當成文字維度」，需在資料來源手動把型別改成 Date、Number、Percent、Currency。建議日期一律用 **`YYYY-MM-DD`（ISO 8601）**，並在 Looker 資料來源把該欄設為 `Date (YYYYMMDD)` 語意型別，時間序列圖與日期範圍控制才會正常。（來源：同上；型別調整說明：<https://support.google.com/looker-studio/answer/9420773>）
- **從 URL / GCS 拉 CSV**：Looker Studio **原生沒有「從任意 URL 抓 CSV」的連接器**；官方檔案上傳連接器是手動上傳。要自動化有三條路：
  1. **BigQuery 外部表 / 載入**：把 CSV 放 GCS，用 BigQuery external table 指向 `gs://…/*.csv`，Looker Studio 接 BigQuery（官方一等公民連接器，支援排程、增量、blend）。**建議做法**。
  2. **Google Sheets**：GitHub Action 用 Sheets API 把資料寫進試算表，Looker 接 Sheets（免費、夠用、但列數與更新頻率有限）。
  3. **社群連接器（Community Connector）** 自己寫一支抓 GitHub Pages / GCS 的 CSV。維護成本高。
  - 現有 code 已能輸出到 GitHub Pages 和（選用）GCS，最小改動是**加開 BigQuery 載入**：`funding-export-*` 後面接 `bq load` 或用 `@google-cloud/bigquery`。

### 4.2 寬表（wide）vs 長表（long / tidy）

- Looker Studio **時間序列圖**：可以直接吃寬表（一欄一條線）。但「加了 2 個以上 metric 時，Breakdown 維度會被停用」（來源：<https://support.google.com/looker-studio/answer/9313988>，時間序列圖說明）。
- 若要做「**用一個下拉選單（data control / 參數）切換要看哪個指標**」，長表（`date, currency, metricName, metricValue`）＋把 `metricName` 當 breakdown 維度比較好——一張圖就能切換，不用每個指標各放一張。
- tidy data 原則：每個變數一欄、每個觀測一列（來源：<https://vita.had.co.nz/papers/tidy-data.pdf>，Wickham, *Tidy Data*, J. Stat. Soft. 2014）。
- **建議：兩者都出**。
  - **主檔＝寬表**（每天一列，欄位多），給固定版面的時間序列圖、計分卡、日期範圍比較——這是 Looker 最好用的形狀，也讓「日期範圍比較（date range comparison）」功能能直接運作（它需要一個有效的日期維度）。
  - **melt 檔＝長表**（`date, currency, metric, value`），只放「會想在單一圖上切換／疊比」的少數指標（各種 return、utilization、benchmark），給指標切換器與 benchmark 疊圖。

### 4.3 計算欄位、混合資料能不能取代預先算好的欄位

- **計算欄位（calculated fields）**：能做同列的四則運算、`CASE`、日期函數、以及少數 running 函數。**不能**跨列做「trailing 30 日幾何連乘」「最大回撤」「標準差窗格」這類需要視窗/序列狀態的計算（Looker Studio 沒有 window function for file/Sheets 來源；BigQuery 來源可用 SQL window，但要寫自訂查詢）。
  - ⇒ **TWR 連乘、波動度、回撤、Sharpe/Sortino、XIRR 必須在腳本端算好**。
  - 單列比率（`idleRatio = 1 − lentRatio`、`excessReturn = twrRet − frrReturn`、`aprGross` 與 `apyNet` 的轉換）可以留給 Looker 計算欄位，減少欄位數。
- **混合資料（data blending）**：一個 blend 最多 **5 張表**，支援 inner / left / right / full outer / cross join，需要 join key（cross 除外）（來源：<https://support.google.com/looker-studio/answer/11542817>、<https://docs.cloud.google.com/looker/docs/studio/how-blends-work-in-looker-studio>）。
  - 可以用 blend 把「我方每日表」與「市場 FRR 每日表」以 `date + currency` join 起來做對比，**不需要在腳本裡把 FRR 併進主檔**。但為了報表穩定與少一層設定，建議還是把 `frrMarket` / `aprMarket` 直接寫進主寬表。
- **日期範圍比較**：Looker 的「比較上期／去年同期」只需要資料來源有一個被辨識為 Date 的維度、且每列粒度到日即可；寬表每日一列天然符合。長表也可以，但 metric 維度會讓比較數字變成「每個 metric 各自比」。

### 4.4 每幣別一檔 vs 合併

- 現況：每幣別一檔（`USD.csv`、`UST.csv`）。
- Looker Studio 檔案上傳「同 dataset 結構需一致、且是 append」——若把多幣別丟同一個 dataset，要嘛每次上傳一個檔、要嘛合併成一個含 `currency` 欄的檔。
- **建議**：
  - 每個輸出檔都**新增 `currency` 欄**。
  - 額外產一份 **`all.csv` / `all.json`**（縱向合併所有幣別），作為 Looker 的單一資料來源，用 `currency` 當 data control 過濾器。
  - 保留 per-currency 檔供除錯與其他用途。

---

## 5. 建議的完整欄位清單

> 命名沿用現有 `camelCase` 與 `lent*` / `apr*` 家族。型別欄的「pct數值」＝沿用現有慣例存「12.34」表示 12.34%；「ratio」＝存 0.1234。資料視窗：`d`＝當日，`Nd`＝trailing N 日含當日，`ITD`＝開帳至當日。
> 「現況」：✅ 已有 / 🔸 已有但建議改算法 / ➕ 新增。

### 5.1 主寬表 `funding-statistics-1/<CCY>.{csv,json}`（每列 = 一個 UTC 日 × 幣別）

| 欄位 | 型別 | 單位 | 定義 / 公式 | 視窗 | 來源 | 現況 | Looker 用途 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `date` | string | — | UTC 日 `YYYY-MM-DD` | d | ledger `mts` | ✅ | 日期維度、時間軸、日期範圍比較 |
| `currency` | string | — | `USD` / `UST` … | d | — | ➕ | data control 過濾 |
| `interest` | number | CCY | category 28 payout 淨額加總 | d | `v2AuthReadLedgersHist(28)` | ✅ | 每日利息長條 |
| `interestCum` | number | CCY | `Σ interest`（開帳起） | ITD | 累加 | ➕ | 累積利息面積圖 |
| `balance` | number | CCY | 當日 payout 後餘額最大值 | d | ledger `balance` | ✅ | — |
| `investment` | number | CCY | `balance − interest`（可投入本金） | d | 推導 | ✅ | 本金曲線 |
| `netFlow` | number | CCY | 當日外部現金流淨額（入 +／出 −） | d | ledger cat 51/101/104, `wallet=funding` | ➕ | 標記失真日、歸因 |
| `flowFlag` | string | — | `''` / `deposit` / `withdrawal`（\|netFlow\| 佔 investment > 5% 時） | d | 推導 | ➕ | 圖上註記、篩掉失真日 |
| `dpr` | number | pct數值 | `interest × 100 / investment` | d | 現行 | 🔸(分母議題) | 每日報酬散點 |
| `dprGeoBase` | number | ratio | `interest / investment`（供連乘，= dpr/100） | d | 推導 | ➕ | — |
| `equity` | number | index | `∏_{≤d}(1 + dprGeoBase)`，起點 1.0 | ITD | 連乘 | ➕ | **淨值曲線（TWR 圖形化）** |
| `drawdown` | number | ratio | `equity / max(equity_{≤d}) − 1` | ITD | 推導 | ➕ | 回撤面積圖 |
| `apr1` | number | pct數值 | `dpr × 365`（算術年化，indicative） | d | 現行 | 🔸(標示為近似) | 直覺用計分卡 |
| `apr7` `apr30` `apr365` | number | pct數值 | trailing N 日 `apr1` 算術平均 | 7/30/365d | 現行 | 🔸(建議改幾何) | 現有圖表相容 |
| `twrRet7` `twrRet30` `twrRet365` | number | pct數值 | `[∏_{Nd}(1 + dprGeoBase) − 1] × 100`（**不年化**） | 7/30/365d | 連乘 | ➕ | 滾動報酬折線 |
| `twrRetItd` | number | pct數值 | `[∏_{ITD}(1 + dprGeoBase) − 1] × 100` | ITD | 連乘 | ➕ | ITD 計分卡 |
| `aprGeo365` | number | pct數值 | `[(1 + twrRet365/100)^(365/n) − 1] × 100`，n = 視窗實際天數 | 365d | 推導 | ➕ | 「真年化」計分卡 |
| `aprGeoItd` | number | pct數值 | `[(equity_d)^(365 / daysSinceInception) − 1] × 100` | ITD | 推導 | ➕ | ITD 年化 |
| `xirrItd` | number | pct數值 | 使 {netFlow_d 為負, 期末 balance 為正} NPV=0 的年化 IRR | ITD | 現金流求解 | ➕ | 「個人實際年化」計分卡 |
| `volDaily30` | number | ratio | `stdev(dprGeoBase)`，trailing 30 日 | 30d | 推導 | ➕ | 波動度折線 |
| `volAnnual30` | number | pct數值 | `volDaily30 × sqrt(365) × 100` | 30d | 推導 | ➕ | 風險計分卡 |
| `downsideDev30` | number | ratio | 低於 MAR 的 `dprGeoBase` 的下方標準差 | 30d | 推導 | ➕ | Sortino 分母 |
| `sharpe30` | number | 比值 | `(aprGeo30_equiv − rf) / volAnnual30` | 30d | 推導 | ➕ | 風險調整計分卡 |
| `sortino30` | number | 比值 | `(aprGeo30_equiv − mar) / (downsideDev30 × sqrt(365))` | 30d | 推導 | ➕ | 風險調整計分卡 |
| `maxDrawdownItd` | number | ratio | `min_{≤d}(drawdown)` | ITD | 推導 | ➕ | 計分卡（多半 ≈ 0，賣點） |
| `lentRatio1` `lentRatio7` `lentRatio30` `lentRatio365` | number | pct數值 | 時間加權放出/可投入（ADR-0001） | 1/7/30/365d | 現行 | ✅ | 利用率折線 |
| `idleRatio30` | number | pct數值 | `100 − lentRatio30` | 30d | 推導 | ➕(或 Looker 算) | 閒置面積 |
| `offerPendingRatio` | number | pct數值 | 掛單中未成交 / investment（快照） | d | `v2AuthReadFundingOffers` | ➕ | 閒置拆解 |
| `rateWeightedAvg` | number | pct數值 | `yieldLend × 365 × 100`（加權平均出借 APR） | d 快照 | `v2AuthReadInfoFunding` | ➕ | 我方利率 vs 市場 |
| `periodWeightedAvg` | number | 天 | `durationLend` | d 快照 | `v2AuthReadInfoFunding` | ➕ | 天期折線 |
| `rateP25` `rateMedian` `rateP75` | number | pct數值 | 當日新承作出借 APR 分位數 | d | `v2AuthReadFundingTradesHist` | ➕ | 利率分布帶狀圖 |
| `creditsOpenCount` | int | 筆 | 當日進行中出借筆數 | d | credits | ➕ | 活動計分卡 |
| `creditsOpenAmount` | number | CCY | 當日進行中出借金額 | d | credits | ➕ | — |
| `creditsNewCount` `creditsNewAmount` | int/number | 筆/CCY | 當日新承作 | d | funding trades | ➕ | 承作量長條 |
| `avgTicket` | number | CCY | `creditsOpenAmount / creditsOpenCount` | d | 推導 | ➕ | — |
| `frrMarket` | number | pct數值 | 市場 FRR 年化 `frr × 100`（`frr` 已 ×365） | d | `v2FundingStatsHist` | ➕ | **benchmark 疊線** |
| `aprMarketGeo` | number | pct數值 | 市場 `apr × 100`（≈ 日複利年化） | d | `v2FundingStatsHist` | ➕ | benchmark |
| `periodMarket` | number | 天 | 市場 `avgPeriod` | d | `v2FundingStatsHist` | ➕ | 天期對照 |
| `lentRatioMarket` | number | pct數值 | `amountUsed / amount × 100`（市場使用率，口徑不同） | d | `v2FundingStatsHist` | ➕ | 市場熱度對照 |
| `excessApr30` | number | pct數值 | `aprGeo30_equiv − frrMarket`（同視窗） | 30d | 推導 | ➕(或 Looker 算) | 超額報酬 |
| `frrGap` | number | pct數值 | `rateWeightedAvg − frrMarket` | d | 推導 | ➕ | 選價能力 |

（`rf` = 無風險利率參數，預設 0；`mar` = 最低可接受報酬參數，預設 = `frrMarket` 或固定 APR 5%。兩者寫進腳本設定，並在輸出檔頭或 meta 檔記錄採用值。）

### 5.2 長表 melt 檔 `funding-statistics-1/<CCY>.long.csv`（選做）

`date, currency, metric, value` — `metric ∈ {dpr, twrRet7, twrRet30, twrRet365, aprGeo365, lentRatio30, frrMarket, aprMarketGeo, excessApr30, …}`。只放會想在單圖切換／疊比的指標。

### 5.3 期間報酬摘要檔 `funding-statistics-1/<CCY>.periods.csv`（選做，每次覆寫）

`currency, asOf, period, retTwr, retAnnualized, retXirr, retBenchmark, excess, utilization, volAnnual, sharpe, sortino, maxDrawdown`
`period ∈ {MTD, QTD, YTD, 1M, 3M, 1Y, ITD}`。給「期間報酬表」一次做完。

### 5.4 出借明細檔 `funding-export-credits-1/<CCY>.csv`（擴充）

現有 `id, amount, period, rate, side, status, openedAt, closedAt, createdAt, updatedAt`，建議加：

| 欄位 | 定義 | 用途 |
| --- | --- | --- |
| `currency` | 幣別 | 合併檔過濾 |
| `apr` | `rate × 365`（名目年化） | 直接看年化 |
| `durationDays` | `(closedAt − openedAt)` 實際天數 | 實際 vs 約定天期 |
| `interestEst` | `amount × rate × durationDays`（毛估，未扣分成） | 單筆貢獻 |
| `isForcedClose` | `status` 非 `CLOSED (expired)` | 違約／提前平倉統計 |
| `positionPair` | 對手部位交易對（API 已有，未輸出） | 對手集中度分析 |

---

## 6. JSON / CSV 結構建議

### 6.1 結論

1. **主檔維持「每日一列」的寬表**，但：
   - 每列加 `currency`。
   - 新增 §5.1 的欄位（TWR、風險、benchmark、活動）。
   - JSON 從「裸陣列」改為 `{ meta: {...}, rows: [...] }`（見下），CSV 維持裸表。
2. **新增合併檔** `all.csv` / `all.json`（所有幣別縱向合併），當 Looker 的單一資料來源。
3. **新增長表** `<CCY>.long.csv` + `all.long.csv`（選做，Phase 3）。
4. **新增期間摘要** `<CCY>.periods.csv` + `all.periods.csv`（選做，Phase 2）。
5. **出借明細**依 §5.4 擴充，並加 `all.csv`。
6. **日期一律 `YYYY-MM-DD`**；百分比欄位維持「pct 數值」慣例並在 `meta` 標注；空值輸出空字串（CSV）／`null`（JSON），不要輸出 `NaN`。
7. **自動化到 Looker**：加一支步驟把 `all.csv` `bq load` 進 BigQuery（或寫進 Google Sheet），Looker 接 BigQuery/Sheets；GitHub Pages 版保留給人工檢視與備援。

### 6.2 JSON 建議形狀（主檔）

```jsonc
{
  "meta": {
    "schema": 3,
    "currency": "USD",
    "generatedAt": "2026-08-30T00:45:12Z",
    "inceptionDate": "2024-01-15",
    "units": { "percent": "value×100 (12.34 = 12.34%)", "amount": "USD" },
    "params": { "riskFree": 0, "mar": "frrMarket", "interestIsNetOfFee": true },
    "windows": ["1d", "7d", "30d", "365d", "ITD"]
  },
  "rows": [
    { "date": "2024-01-15", "currency": "USD", "interest": 0.12, "interestCum": 0.12, /* … */ }
  ]
}
```

CSV 就是 `rows` 攤平（`Papa.unparse`）。`meta` 另外寫一份 `<CCY>.meta.json`，避免 CSV 使用者拿不到。

### 6.3 長表 vs 寬表的取捨（落地）

- 寬表：欄位會膨脹到 ~45 欄。Looker 檔案上傳的欄名／結構限制都能滿足（英數底線、≤128 字元）。時間序列、計分卡、日期比較全部直接可用。
- 長表：只在「單圖切換指標」「benchmark 疊圖」時才需要；不必把全部指標 melt，挑 ~10 個。
- 不建議「只出長表」：計分卡、日期範圍比較、同列計算欄位（`idleRatio = 1 − lentRatio`）在長表都要多繞一層 filter。

---

## 7. `tplStat()` 擴充後的 TypeScript 介面草稿

```ts
/** 百分比欄位一律存「數值 ×100」：12.34 代表 12.34%。金額欄位單位為該幣別。 */
interface DailyStat {
  // ── 識別 ──
  date: string            // 'YYYY-MM-DD' (UTC)
  currency: string        // 'USD' | 'UST' | …

  // ── 利息與本金（沿用現有）──
  interest: number        // 當日 category 28 payout 淨額加總
  interestCum: number     // 開帳至當日累積利息
  balance: number | null  // 當日 payout 後餘額最大值
  investment: number | null // = balance − interest（可投入本金）

  // ── 外部現金流 ──
  netFlow: number         // 入金 + / 出金 −（ledger cat 51/101/104, wallet=funding）
  flowFlag: '' | 'deposit' | 'withdrawal'

  // ── 日報酬 ──
  dpr: number             // 現行：interest×100/investment（pct 數值）
  dprGeoBase: number      // = dpr/100（ratio，供連乘）

  // ── 淨值 / 回撤（ITD 連乘）──
  equity: number          // ∏(1 + dprGeoBase)，起點 1.0
  drawdown: number        // equity / running-max − 1（≤ 0）
  maxDrawdownItd: number

  // ── 年化：算術（indicative，沿用）＋幾何（新增）──
  apr1: number; apr7: number; apr30: number; apr365: number       // 算術，保留相容
  twrRet7: number; twrRet30: number; twrRet365: number            // trailing 幾何累積，未年化
  twrRetItd: number
  aprGeo365: number; aprGeoItd: number                            // 幾何年化（僅 ≥1yr / ITD）
  xirrItd: number                                                 // 資金加權年化 IRR

  // ── 風險（trailing 30d）──
  volDaily30: number; volAnnual30: number
  downsideDev30: number
  sharpe30: number; sortino30: number

  // ── 資金利用率（沿用 + 拆解）──
  lentRatio1: number; lentRatio7: number; lentRatio30: number; lentRatio365: number
  idleRatio30: number
  offerPendingRatio: number

  // ── 出借活動 ──
  rateWeightedAvg: number   // yieldLend×365×100（APR）
  periodWeightedAvg: number // durationLend（天）
  rateP25: number; rateMedian: number; rateP75: number
  creditsOpenCount: number; creditsOpenAmount: number
  creditsNewCount: number; creditsNewAmount: number
  avgTicket: number

  // ── Benchmark（Bitfinex funding market）──
  frrMarket: number        // frr×100（frr 已 ×365）
  aprMarketGeo: number     // apr×100
  periodMarket: number     // avgPeriod
  lentRatioMarket: number  // amountUsed/amount×100
  excessApr30: number      // aprGeo30_equiv − frrMarket
  frrGap: number           // rateWeightedAvg − frrMarket
}

interface StatsFile {
  meta: {
    schema: 3
    currency: string
    generatedAt: string
    inceptionDate: string
    units: Record<string, string>
    params: { riskFree: number; mar: number | 'frrMarket'; interestIsNetOfFee: boolean }
    windows: string[]
  }
  rows: DailyStat[]
}

// tplStat 對應改成：
const tplStat = (date: string, currency: string): DailyStat => ({
  date, currency,
  interest: 0, interestCum: 0, balance: null, investment: null,
  netFlow: 0, flowFlag: '',
  dpr: 0, dprGeoBase: 0, equity: 1, drawdown: 0, maxDrawdownItd: 0,
  apr1: 0, apr7: 0, apr30: 0, apr365: 0,
  twrRet7: 0, twrRet30: 0, twrRet365: 0, twrRetItd: 0,
  aprGeo365: 0, aprGeoItd: 0, xirrItd: 0,
  volDaily30: 0, volAnnual30: 0, downsideDev30: 0, sharpe30: 0, sortino30: 0,
  lentRatio1: 0, lentRatio7: 0, lentRatio30: 0, lentRatio365: 0,
  idleRatio30: 0, offerPendingRatio: 0,
  rateWeightedAvg: 0, periodWeightedAvg: 0, rateP25: 0, rateMedian: 0, rateP75: 0,
  creditsOpenCount: 0, creditsOpenAmount: 0, creditsNewCount: 0, creditsNewAmount: 0, avgTicket: 0,
  frrMarket: 0, aprMarketGeo: 0, periodMarket: 0, lentRatioMarket: 0, excessApr30: 0, frrGap: 0,
})
```

實作注意：

- `equity` / `twrRet*` / `drawdown` / `vol*` / `sharpe` / `sortino` 都要在「補完每日列、`orderedDates` 排好」之後、用前綴或滑動視窗算（跟現有 `lentRatio` 前綴和同一段）。
- `dprGeoBase` 建議用 `ln(1 + r)` 前綴和做連乘，避免長期乘積浮點誤差：`twrRet = expm1(prefixLn[hi] − prefixLn[lo])`。
- `xirrItd` 需要現金流清單（每個 `netFlow ≠ 0` 的日 + 期末 `balance`），用 Newton–Raphson 解；lodash 沒有，手刻約 20 行，寫成純函式 + vitest fixture（比照 `calcTargetRate`）。
- benchmark 需要多打 `Bitfinex.v2FundingStatsHist({ currency, start, end, limit: 250 })` 分頁回填歷史；市場資料點是「每 X 分鐘」，要 resample 成每日（取當日最後一筆或均值）。
- `rateWeightedAvg` / `periodWeightedAvg` / `offerPendingRatio` 來自即時快照 API，只有「執行當下」準確，歷史列只能留今天這格或標為快照；若要歷史逐日，得從 `funding-export-credits-1` 的 credits + trades 自行加權回算。

---

## 8. 現有算法的問題與改進點

| # | 問題 | 說明 | 影響 | 建議 |
| --- | --- | --- | --- | --- |
| 1 | **算術年化 + 簡單平均** | `apr7/30/365` = 每日 `dpr×365` 的算術平均，非幾何連乘 | 低估複利；缺資料日把平均拉低；違反 GIPS「短期不年化」（來源：CFA Institute refresher） | 新增 `twrRet*`（幾何、不年化）與 `aprGeo365`；`apr*` 保留但標「indicative」 |
| 2 | **`dpr` 分母口徑** | `interest / investment`，`investment` = 當日起始本金 | 當日大額入金時分母滯後，`dpr` 短暫爆高（與 `lentRatio` 同病，ADR-0001 決策 2 已記錄不修正）；理論上該用當日「時間加權平均本金」 | 至少輸出 `netFlow` / `flowFlag` 讓報表能篩掉失真日；ITD 數字改看 `xirrItd`（現金流正確） |
| 3 | **完全沒有風險指標** | 無淨值曲線、回撤、波動度、Sharpe/Sortino | 報告只有「賺多少」沒有「穩不穩」，無法對外展示風險調整後績效 | 加 `equity` / `drawdown` / `vol*` / `sharpe30` / `sortino30`（放貸的 Sortino 會很漂亮） |
| 4 | **沒有 benchmark** | 沒跟市場 FRR 比 | 無法回答「機器人比躺著吃 FRR 好多少」 | 加 `frrMarket` / `aprMarketGeo` / `excessApr30` / `frrGap`（資料免費、同幣別，來源：docs.bitfinex.com funding-stats） |
| 5 | **ITD 用錯口徑** | 沒有「開帳以來」的單一數字；就算加也不能用 `dpr` 平均 | 有入金史時，算術／TWR 都不等於「我實際賺的年化」 | 加 `xirrItd`（資金加權），並在報表把「策略 TWR」與「個人 XIRR」分開講 |
| 6 | **`apr7/30/365` 用「未來灑值」實作** | 迴圈把每天 `apr1` 加到未來 N 天 | O(N) per day、可讀性差、與 `lentRatio` 的前綴和風格不一致 | 統一改成 `ln(1+r)` 前綴和 / 滑動視窗 |
| 7 | **加權平均利率／天期沒抓** | API 直接有 `yieldLend` / `durationLend` | 少了「選價能力」「天期策略」的可視性 | 加 `rateWeightedAvg` / `periodWeightedAvg` |
| 8 | **`funding-export-credits-1` 去重只比相鄰** | 分頁重疊會漏，靠下游補 | CSV 有重複列（ADR-0001 決策 5） | 順手改成 `Set<id>` 全域去重（低風險小改） |
| 9 | **JSON 是裸陣列、無 meta** | 拿不到單位、inception、參數 | 消費端要靠猜；schema 版本只藏在 DB | JSON 改 `{ meta, rows }`，另出 `<CCY>.meta.json` |
| 10 | **Looker 串接是手動** | GitHub Pages 靜態檔，Looker 檔案上傳要人工 | 更新不即時、易忘 | 加 `bq load` 或 Sheets 寫入步驟到 `gh-pages.yml` |

---

## 9. 分階段落地建議

### Phase 1 — 低風險、高效益（先做）

1. 主檔每列加 `currency`；新增合併檔 `all.csv` / `all.json`。
2. JSON 改 `{ meta, rows }` + `<CCY>.meta.json`。
3. 新增 `interestCum`、`equity`（`ln(1+r)` 前綴和）、`drawdown`、`maxDrawdownItd`、`twrRet7/30/365`、`twrRetItd`、`aprGeo365`、`aprGeoItd`。
4. 新增 benchmark：`frrMarket` / `aprMarketGeo` / `periodMarket` / `lentRatioMarket`（`v2FundingStatsHist` 分頁回填 + resample 每日）。
5. 新增 `netFlow` / `flowFlag`（ledger cat 51/101/104）。
6. Telegram 每日報告加一行「vs 市場 FRR：+X.XX%」。
7. `funding-export-credits-1` 去重改 `Set<id>`，並加 `currency` / `apr` / `durationDays` / `isForcedClose` / `positionPair`。
8. 純函式（TWR 連乘、drawdown、XIRR、resample）比照 `calcTargetRate` 寫 vitest + `__fixtures__` 快照。

### Phase 2 — 風險指標與期間表（次做）

9. `volDaily30` / `volAnnual30` / `downsideDev30` / `sharpe30` / `sortino30`（`rf`、`mar` 參數化，寫進 `meta`）。
10. `xirrItd`（Newton–Raphson，用 `netFlow` + 期末 `balance`）。
11. `rateWeightedAvg` / `periodWeightedAvg`（`v2AuthReadInfoFunding` 快照 + 從 credits/trades 回算歷史）。
12. 期間摘要檔 `<CCY>.periods.csv` / `all.periods.csv`（MTD/QTD/YTD/1M/3M/1Y/ITD）。
13. 出借活動欄位：`creditsOpenCount/Amount`、`creditsNewCount/Amount`、`avgTicket`、`rateP25/Median/P75`。

### Phase 3 — 自動化與進階（選做）

14. `gh-pages.yml` 加 `bq load` / Sheets 寫入；Looker 資料來源切到 BigQuery。
15. 長表 melt 檔 `<CCY>.long.csv` / `all.long.csv`（挑 ~10 指標）。
16. `offerPendingRatio`、`frrGap`、對手部位集中度（`positionPair` 分組）。
17. Looker 報表改版：淨值 vs benchmark 疊圖、滾動報酬、回撤帶、風險計分卡、期間報酬表、利率分布帶狀圖。
18. 考慮把 `dpr` 分母改成「當日時間加權平均本金」（需 intraday ledger，較大改動，先評估效益）。

---

## 10. 參考資料清單

**GIPS / 報酬率口徑（一手）**

- CFA Institute — Overview of the Global Investment Performance Standards（TWR 為必須、MWR 僅特定情況允許、未滿一年不得年化、扣除交易成本）：<https://www.cfainstitute.org/insights/professional-learning/refresher-readings/2026/overview-of-the-global-investment-performance-standards>
- GIPS Standards Handbook for Firms（官方）：<https://www.gipsstandards.org/standards/gips-standards-for-firms/gips-standards-handbook-for-firms/>
- GIPS Guidance Statement on Calculation Methodology（幾何連結、Modified Dietz、大額現金流）：<https://www.gipsstandards.org/wp-content/uploads/2021/03/calculation_methodology_gs_2011.pdf>
- K&L Gates — A First Look at the 2020 GIPS Standards（2020 版放寬 MWR 使用條件的背景）：<https://www.klgates.com/A-First-Look-at-the-CFA-Institutes-Final-2020-GIPS-Standards-07-01-2019>

**風險指標**

- Charles Schwab — Using the Sortino Ratio to Gauge Downside Risk（Sortino：MAR、下方偏差）：<https://www.schwab.com/learn/story/using-sortino-ratio-to-gauge-downside-risk>
- （Sharpe/Sortino 概念亦見上述 CFA Institute refresher）

**Bitfinex API（一手，docs.bitfinex.com）**

- Funding Statistics（FRR、AVG_PERIOD、FUNDING_AMOUNT(_USED)、FRR→APR 換算）：<https://docs.bitfinex.com/reference/rest-public-funding-stats>
- Ledgers（category 參數表，28 = margin/swap/interest payment）：<https://docs.bitfinex.com/reference/rest-auth-ledgers>
- Funding Credits History：<https://docs.bitfinex.com/reference/rest-auth-funding-credits-hist>
- Funding Trades History：<https://docs.bitfinex.com/reference/rest-auth-funding-trades-hist>
- Funding Info（YIELD_LEND / DURATION_LEND）：<https://docs.bitfinex.com/reference/rest-auth-info-funding>
- Candles（funding 蠟燭符號格式、欄位、limit）：<https://docs.bitfinex.com/reference/rest-public-candles>

**Looker Studio（一手，Google Cloud / support.google.com）**

- Upload CSV files to Looker Studio（100 MB/dataset、2 GB/user、append 非 merge、UTF-8、欄名規則、結構需一致）：<https://docs.cloud.google.com/looker/docs/studio/upload-csv-files-to-looker-studio>
- How blends work in Looker Studio（最多 5 表、join 類型）：<https://support.google.com/looker-studio/answer/11542817>
- How blends work（Google Cloud 版）：<https://docs.cloud.google.com/looker/docs/studio/how-blends-work-in-looker-studio>
- Time series charts（多 metric 時停用 breakdown）：<https://support.google.com/looker-studio/answer/9313988>
- About data source fields / 型別調整：<https://support.google.com/looker-studio/answer/9420773>

**資料形狀**

- Hadley Wickham, *Tidy Data*, Journal of Statistical Software 59(10), 2014：<https://vita.had.co.nz/papers/tidy-data.pdf>

**專案內部**

- `.claude/docs/adr/0001-lent-ratio-calculation.md` — 資金利用率計算口徑
- `.claude/docs/CONTEXT.md` — domain 詞彙（出借、可投入本金、資金利用率、利息經濟日、年化）
- `bin/funding-statistics-1.ts`、`bin/funding-export-credits-1.ts`、`bin/funding-auto-renew-3.ts`
- `@taichunmin/bitfinex` 型別：`node_modules/@taichunmin/bitfinex/dist/index.d.ts`、原始碼 `/Users/taichunmin/git/js-bitfinex/src/`（`bitfinex.ts`、`enums.ts`、`zod/`）
