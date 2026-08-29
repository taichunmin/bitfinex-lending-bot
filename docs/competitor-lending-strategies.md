# 其他 Bitfinex 放貸機器人的策略研究

本文整理公開的 Bitfinex 融資（funding／綠葉放貸）機器人，逐一拆解它們**決定利率、出借期間、金額切分、掛單重掛時機**的實際程式邏輯，並對照本專案 `bin/funding-auto-renew-3.ts` 找出可以借鏡的點子。

所有聲明都盡量標到第一手出處（GitHub 檔案 + 行號，或文章 URL）。研究日期：2026-08-29。

---

## 本專案策略（對照基準）

`bin/funding-auto-renew-3.ts` 的做法（詳見 [`funding-auto-renew-3.md`](./funding-auto-renew-3.md)）：

- **利率**：抓過去一天的 `1m` K 線，把每根的 `[low, high]` 當利率區間、`volume` 當成交量，二分搜尋找出「累積成交量 ÷ 總成交量 = 目標分位 `rank`」的利率，再用 `rateMin` / `rateMax` 夾住。
- **期間**：用 `period` 對照表（天數 → 利率門檻）做線性插值，`clamp` 到 `2 ~ 120`。
- **金額切分**：不切分。直接寫一組 auto-renew 設定，交給 Bitfinex 的 auto-renew 機制掛單。
- **重掛時機**：每 10 分鐘跑一次；只要算出的設定和現有 auto-renew 不同，就關掉舊 auto-renew、取消該幣別所有 offer、寫入新設定。
- **沒有做**：梯度／階梯掛單、FRR 相關邏輯、閒置資金偵測、市場狀態機、回測、複利換算顯示。

---

## 概述表格

| 機器人 | 語言 | 維護狀態（最後 push / stars） | 利率策略一句話 |
| --- | --- | --- | --- |
| [BitBotFactory/MikaLendingBot](https://github.com/BitBotFactory/MikaLendingBot) | Python 2 | 停更（2020-12 / ~1.2k★） | 在 lend book 指定「深度區間」`[gapBottom, gapTop]` 取利率，於此區間內平均鋪 `spreadLend` 張梯度單；可選 FRR 當下限、可選市場分析（percentile／MACD）抬高下限 |
| [eAndrius/BitfinexLendingBot](https://github.com/eAndrius/BitfinexLendingBot) | Go | 停更（2018-12 / ~168★） | 兩套策略：MarginBot（lend book 深度 + 梯度單 + HighHold）與 CascadeBot（FRR + 增量起掛，逾時逐步降息） |
| [huaying/bitfinex-lending-bot](https://github.com/huaying/bitfinex-lending-bot) | JavaScript | 停更（2023-01 / ~63★） | order book 累積量門檻取基準利率，之後金字塔式（金額指數成長、利率指數加碼）鋪單 |
| [instabot42/funding-bot](https://github.com/instabot42/funding-bot) | JavaScript | 低度維護（2023-07 / ~34★） | 每個「offer block」用 `FRR × 倍率` 與 `atLeastLow/High` 夾出利率區間，用 easing 曲線鋪 N 張單、金額可隨機化 |
| [a6984234/Andy-Bitfinex-Loan-Bot](https://github.com/a6984234/Andy-Bitfinex-Loan-Bot) | C# | 有動靜（2025-08 / ~21★） | 取過去 12h 的 30m K 線最高 11 根的均值當利率，被最新成交價刷新，`LowestPrice` 當下限 |
| [liverpool1026/funding_bot](https://github.com/liverpool1026/funding_bot) | Python | 停更（2021-03 / ~10★） | 取 5m／30m K 線的 `high × 0.99` 當利率，逾時重掛時改用更短窗；一次只掛一張 |
| [cryptic-core/bf-lending-bot](https://github.com/cryptic-core/bf-lending-bot) | Python | 有動靜（2026-07 / ~6★） | 依 funding book 各天期的量加權均價 + 借款情緒（sentiment）加成，於 `[均價, 均價×調整倍率]` 間鋪 10 張梯度單 |
| [MMquant/BFX-lending-bot](https://github.com/MMquant/BFX-lending-bot) | MATLAB | 停更（2017-07 / ~7★） | **本專案「成交量分位」做法的鼻祖**：離線用 10 天成交資料算出「85% 機率兩次內成交」的量門檻，掛在 lend book 累積量首度低於門檻的利率 |
| [hankwu0501/bitfinex-lending-bot](https://github.com/hankwu0501/bitfinex-lending-bot) | JS/TS | 活躍（2026-06 / 0★） | 從 huaying fork，新增 Hybrid 策略：`max(FRR×factor, book@50k, floor)` 當 baseRate，8 層加權階梯 + 頂層 cascade 逐時降息 + 原生 FRRDELTAVAR 常駐單 |
| [ipmman/lending-bot](https://github.com/ipmman/lending-bot) | Python | 活躍（2026-07 / ~1★） | 三階段狀態機：FRR×0.98 掛 1 分鐘 → 連 3 次沒中改 book×0.99 搶 10 秒 → 連 6 次沒中熔斷休息 60 秒 |
| [allen032062/bitfinex-funding-bot](https://github.com/allen032062/bitfinex-funding-bot) | Python | 活躍（2026-08 / 0★） | 波動率狀態機（低波動→FRR 保底 / 高波動→階梯 / 中波動有大牆→搶牆 / 其餘→觀望），附完整回測框架 |
| [Kenblair1226/bitfinex_lending_bot](https://github.com/Kenblair1226/bitfinex_lending_bot) | Python | 停更（2026-02 / 0★） | 以監控 + Telegram 通知為主，掛單邏輯很薄 |
| [mingchengchen/BitfinexFundingBot](https://github.com/mingchengchen/BitfinexFundingBot) | Python | 停更（2021-01 / ~3★） | WebSocket 版；直接抄 ticker 的「最新 bid 利率 / bid 天期」掛單，逾時 120 秒重掛 |
| yk-study「免費 Bitfinex 放貸機器人」 | Google Apps Script | 部落格教學（2022） | 百分比分批 + order book 累積量門檻取利率 + 最低利率保底（與本專案思路相近） |
| [drodil/bitfinex_bot](https://github.com/drodil/bitfinex_bot) | Python | 停更（2021-04 / ~9★） | **不是放貸機器人**，是現貨技術指標交易機器人（列此僅為釐清） |

---

## 各機器人詳述

### BitBotFactory/MikaLendingBot

Python 2、~1.2k★、最後 commit 2020-12（`b59ab87`），開發者自述進入「Out of Office」狀態、只收社群 PR，實務上已停更。同時支援 Poloniex 與 Bitfinex。

**利率決定**（[`modules/Lending.py`](https://github.com/BitBotFactory/MikaLendingBot/blob/b59ab87/modules/Lending.py)）：

- 核心是「gap mode」：在 lend book 上往下累積掛單量，累積到 `gapBottom`（深度）時的利率當**最低掛單利率**，累積到 `gapTop` 時的利率當**最高掛單利率**（`get_gap_rate` [L320-L337](https://github.com/BitBotFactory/MikaLendingBot/blob/b59ab87/modules/Lending.py#L320-L337)）。深度單位有三種：`relative`（佔自己餘額的百分比）、`raw`（幣本位絕對值）、`rawbtc`（BTC 本位）。預設 `gapMode = RawBTC`、`gapbottom = 40`、`gaptop = 200`、`spreadlend = 3`（[`default.cfg.example` L39-L48](https://github.com/BitBotFactory/MikaLendingBot/blob/b59ab87/default.cfg.example#L39-L48)）。
- `construct_orders` [L348-L378](https://github.com/BitBotFactory/MikaLendingBot/blob/b59ab87/modules/Lending.py#L348-L378)：在 `[bottom_rate, top_rate]` 之間**等距**切 `spreadLend` 個利率點，超過 `maxdailyrate` 的點全部壓到 `maxdailyrate`。
- 下限 `mindailyrate`（預設 0.005%/日）。可選 `frrasmin = True`：改用 `FRR + frrdelta` 當下限（`get_frr_or_min_daily_rate` [L258-L281](https://github.com/BitBotFactory/MikaLendingBot/blob/b59ab87/modules/Lending.py#L258-L281)）。
- 可選 `MarketAnalysis` 模組（[`modules/MarketAnalysis.py`](https://github.com/BitBotFactory/MikaLendingBot/blob/b59ab87/modules/MarketAnalysis.py)）：每 5 秒抓 lend book 最佳報價寫進 SQLite，`get_rate_suggestion` [L285-L326](https://github.com/BitBotFactory/MikaLendingBot/blob/b59ab87/modules/MarketAnalysis.py#L285-L326) 可用兩種方法算「建議下限」——`percentile`（過去 `percentile_seconds`≈3 天資料的第 `lendingStyle`=75 百分位）或 `MACD`（短窗均值 vs 長窗均值，短 > 長視為多頭、回傳短窗均值 × `daily_min_multiplier`=1.05）。算出的值若高於 `mindailyrate` 就取代它。

**期間決定**（`create_lend_offer` [L167-L196](https://github.com/BitBotFactory/MikaLendingBot/blob/b59ab87/modules/Lending.py#L167-L196)）：預設 2 天。若利率 `>= xdaythreshold`（預設 0.2%/日）→ 掛 `xdays`（預設 60）。若設了 `xdayspread`，則在 `xdaythreshold/xdayspread ~ xdaythreshold` 之間對天數做**線性插值**（2 天 ↔ xdays 天）。另有 `endDate`：接近結束日時把天數壓到剩餘天數，剩 ≤2 天就停止放貸。

**金額切分**（`construct_orders`）：把可動用餘額**平均**分成 `spreadLend` 份（截斷到 8 位小數，餘數塞第一張）。`get_cur_spread` [L340-L345](https://github.com/BitBotFactory/MikaLendingBot/blob/b59ab87/modules/Lending.py#L340-L345) 會在餘額不夠鋪滿 N 份時自動減少份數。每張單掛在「競爭者利率 − 0.000001」（[L169-L171](https://github.com/BitBotFactory/MikaLendingBot/blob/b59ab87/modules/Lending.py#L169-L171)）。

**閒置資金上限**（[`modules/MaxToLend.py`](https://github.com/BitBotFactory/MikaLendingBot/blob/b59ab87/modules/MaxToLend.py)）：`maxtolend` / `maxpercenttolend` + `maxtolendrate`——當市場利率低於 `maxtolendrate` 時，只放出上限額度、其餘留著等好價。

**重掛時機**（`lendingbot.py` 主迴圈）：`sleeptimeactive`=60 秒 / `sleeptimeinactive`=300 秒（沒東西可放時）。每輪 `cancel_all` 取消舊單再重鋪；`keepstuckorders = True` 時，若取消後餘額會低於 `minloansize` 就不取消那張卡住的單。

**特殊功能**：`transferCurrencies` 自動把 exchange 錢包轉進 lending 錢包；Telegram／Slack／Email 通知（新成交、xday 門檻觸發、每日彙總）；內建 web 儀表板。

---

### eAndrius/BitfinexLendingBot

Go、~168★、最後 commit 2018-12（`51a6694`）。設計成 cron 每 10 分鐘跑一次（[README L68](https://github.com/eAndrius/BitfinexLendingBot/blob/51a6694/README.md)）。透過 `strategy.Active` 切換兩套策略（[`strategy.go` L24-L31](https://github.com/eAndrius/BitfinexLendingBot/blob/51a6694/strategy.go#L24-L31)）。

#### MarginBot 策略（[`marginbot.go`](https://github.com/eAndrius/BitfinexLendingBot/blob/51a6694/marginbot.go)）

思路和 MikaLendingBot 幾乎一樣（註解也寫 inspired by HFenter/MarginBot）：

- **利率**（`marginBotGetLoanOffers` [L130-L215](https://github.com/eAndrius/BitfinexLendingBot/blob/51a6694/marginbot.go#L130-L215)）：`gapClimb = (GapTop - GapBottom) / numSplits`，從 `GapBottom` 開始，逐一往 lend book 深處累積掛單量直到超過 `nextLend`，取該檔利率；低於 `MinDailyLendRate` 就用下限（[L194-L198](https://github.com/eAndrius/BitfinexLendingBot/blob/51a6694/marginbot.go#L194-L198)）。預設 `GapBottom=100`、`GapTop=5000`、`SpreadLend=3`、`MinDailyLendRate=0.01`（[`default.conf`](https://github.com/eAndrius/BitfinexLendingBot/blob/51a6694/default.conf)）。
- **期間**（[L201-L205](https://github.com/eAndrius/BitfinexLendingBot/blob/51a6694/marginbot.go#L201-L205)）：利率 `>= ThirtyDayDailyThreshold` → 30 天，否則 2 天（二元，沒有插值）。
- **金額切分**：可用餘額平均分 `SpreadLend` 份（截斷 8 位），每份低於 `minLoan` 就自動減份數（[L163-L169](https://github.com/eAndrius/BitfinexLendingBot/blob/51a6694/marginbot.go#L163-L169)）。
- **HighHold**（[L138-L149](https://github.com/eAndrius/BitfinexLendingBot/blob/51a6694/marginbot.go#L138-L149)）：先扣一筆 `HighHoldAmount`，用 `HighHoldDailyRate`（高利率）固定掛 30 天，剩下的才拿去鋪梯度單。用來「保留一部分本金只在高價成交」。
- **重掛**：每次執行先 `CancelActiveOffersByCurrency` 全取消再重鋪（[L57-L62](https://github.com/eAndrius/BitfinexLendingBot/blob/51a6694/marginbot.go#L57-L62)）。`MaxActiveAmount` 限制總放貸額。

#### CascadeBot 策略（[`cascadebot.go`](https://github.com/eAndrius/BitfinexLendingBot/blob/51a6694/cascadebot.go)）

不取消高價單、只隨時間往下降息的「瀑布」策略：

- **起掛利率**（`cascadeBotGetActions` [L200-L204](https://github.com/eAndrius/BitfinexLendingBot/blob/51a6694/cascadebot.go#L200-L204)）：`(FRR + StartDailyLendRateFRRInc) × 365` 當年化，把**所有閒置資金**掛成一張單、天期 `LendPeriod`（預設 2）。FRR 從 lend book 裡標記 `FRR` 的那檔抓（[L79-L85](https://github.com/eAndrius/BitfinexLendingBot/blob/51a6694/cascadebot.go#L79-L85)）。相對原始 cascadebot，改用 FRR 動態起價，避免掛太高長期不成交。
- **降息**（[L164-L198](https://github.com/eAndrius/BitfinexLendingBot/blob/51a6694/cascadebot.go#L164-L198)）：每張既有單只要存活超過 `ReductionIntervalMinutes`（預設 10 分，且應 ≥ 執行間隔），就取消、把利率**降一步**：先線性減 `ReduceDailyLendRate`，再套指數衰減 `(rate - min) × ExponentialDecayMult + min`，最後不低於 `MinDailyLendRate`。剩餘量不足 `minLoan` 就放回錢包等下輪用起掛利率重掛。
- **期間**：沿用原單的 `o.Period`。

---

### huaying/bitfinex-lending-bot

JavaScript、~63★、最後 commit 2023-01（`aece329`），前端 + Node 後端。排程每 3 分鐘檢查一次（[`server/scheduler.js` L9](https://github.com/huaying/bitfinex-lending-bot/blob/aece329/server/scheduler.js#L9)）；每輪 `cancelAllFundingOffers` 全取消再重掛（[`server/submit-funding-offer.js` L52](https://github.com/huaying/bitfinex-lending-bot/blob/aece329/server/submit-funding-offer.js#L52)）。預設只自動放 USD，UST 要手動（[submit-funding-offer.js L45-L48](https://github.com/huaying/bitfinex-lending-bot/blob/aece329/server/submit-funding-offer.js#L45-L48)）。

**基準利率**（`getRate` [`server/utils.js` L47-L65](https://github.com/huaying/bitfinex-lending-bot/blob/aece329/server/utils.js#L47-L65)）：走 funding book 的 offer 側，累積 `數量 × 天期` 超過 `RATE_EXPECTED_OVER_AMOUNT`（預設 5 萬 / 金字塔策略 1 萬）時，取該檔利率 − `1e-8`。這是「訂單簿累積量門檻」，和本專案「成交量分位」不同——它看的是**掛單簿深度**不是**成交量**。

**期間**（`getPeriod` [L34-L45](https://github.com/huaying/bitfinex-lending-bot/blob/aece329/server/utils.js#L34-L45)）：把日利率用 `compoundInterest` 換成年化，比對 `PERIOD_MAP`（[`custom-config.example.js` L28-L36](https://github.com/huaying/bitfinex-lending-bot/blob/aece329/server/custom-config.example.js#L28-L36)：`[[0.3,30],[0.25,20],[0.2,10],[0.15,5],[0.12,3]]`），由高往低找第一個達標的天數，都不到就 2 天。

**金額切分 — 兩種策略**（[`server/strategy.js`](https://github.com/huaying/bitfinex-lending-bot/blob/aece329/server/strategy.js)）：

- `splitEqually` [L4-L28](https://github.com/huaying/bitfinex-lending-bot/blob/aece329/server/strategy.js#L4-L28)：全部用同一個利率，餘額每 `SPLIT_UNIT`（預設 1000）切一張，最後不足 `NUM_ALL_IN`（1100）的整併成一張。
- `splitPyramidally` [L36-L69](https://github.com/huaying/bitfinex-lending-bot/blob/aece329/server/strategy.js#L36-L69)（預設策略）：第 `i` 張的**金額** = `AMOUNT_INIT_MAP` 依 baseRate 查到的起始量 × `AMOUNT_GROW_EXP^i`（預設 1.4，金額指數放大）；**利率** = `baseRate × derivedRate^i`，其中 `derivedRate` 隨 baseRate 在 `[LOW_BOUND_RATE, UP_BOUND_RATE]` 的位置在 `1.0 ~ 1.1` 間變動（利率越低、加碼倍率越大）。等於「越後面的單，金額越大、利率越高」。

**特殊功能**：`compoundInterest` 把日利率換算年化顯示（[`utils.js` L4-L6](https://github.com/huaying/bitfinex-lending-bot/blob/aece329/server/utils.js#L4-L6)）；`sync-funding-earning` 每天固定時間同步收益到 MongoDB；React 儀表板。

---

### instabot42/funding-bot

JavaScript（Bitfinex API v2 WebSocket）、~34★、最後 commit 2023-07（`55e3243`）。每 `updateIntervalMinutes`（預設 60 分）重整一次，多市場錯開執行（[`app.js` L294-L337](https://github.com/instabot42/funding-bot/blob/55e3243/app.js#L294-L337)）。

**設定結構**（[`config/default.json`](https://github.com/instabot42/funding-bot/blob/55e3243/config/default.json)）：每個 symbol 有一組 `offers` 陣列，每個 offer block 是「用 X% 資金、在某個利率帶、鋪 N 張單」。

**利率決定**（`rebalanceFunding` [`app.js` L142-L146](https://github.com/instabot42/funding-bot/blob/55e3243/app.js#L142-L146)）：

```
lowRate  = max(frr × frrMultipleLow,  atLeastLow/100,  bestRate × 0.99)
highRate = max(frr × frrMultipleHigh, atLeastHigh/100, bestRate × 1.1)
```

`bestRate` 是 `recentBestRate`——WebSocket 監聽 funding ticker，記住最近 10 分鐘內看過的最高利率（`trackRate` [L192-L206](https://github.com/instabot42/funding-bot/blob/55e3243/app.js#L192-L206)）。預設 `frrMultipleLow=0.5`、`frrMultipleHigh=5.0`。

**鋪單**（[L153-L173](https://github.com/instabot42/funding-bot/blob/55e3243/app.js#L153-L173)）：用 `scaledPrices(orderCount, lowRate, highRate, easing)` 依 easing 曲線（`linear`／`easein`／`easeout`／`easeinout`／`easeincubic`…）把 N 張單的利率非線性分佈在區間裡。

**金額切分**：block 分到 `totalFunds × amount%`，再用 `scaledAmounts` 切成 `orderCount` 張、可用 `randomAmountsPercent` 隨機化 ±X%（[L159-L161](https://github.com/instabot42/funding-bot/blob/55e3243/app.js#L159-L161)）；每張不低於 `minOrderSize`，資金不夠就減張數。

**期間決定**（`duration` + `normaliseRate` [`app.js` L27-L43](https://github.com/instabot42/funding-bot/blob/55e3243/app.js#L27-L43)、[L169](https://github.com/instabot42/funding-bot/blob/55e3243/app.js#L169)）：利率在 `lendingPeriodLow ~ lendingPeriodHigh` 之間**線性映射**到 `minDays(2) ~ maxDays(30)`；低於 low 全 2 天、高於 high 全 30 天。

**重掛時機**：每輪先取消該 symbol 所有 offer（[L96-L102](https://github.com/instabot42/funding-bot/blob/55e3243/app.js#L96-L102)），等 `sleep` 秒讓餘額回來再重鋪。

**特殊功能**：`alerts` — 利率突破門檻時打 webhook（Alertatron／IFTTT／Zapier／Discord），有 `maxFrequency` 防洗版（[L237-L289](https://github.com/instabot42/funding-bot/blob/55e3243/app.js#L237-L289)）。

---

### a6984234/Andy-Bitfinex-Loan-Bot

C#（Bitfinex.Net）、~21★、最後 push 2025-08。互動式 console 程式，貼 API key 後每 10 秒跑一次（[`AutoLending-Bitfinex/Program.cs` L84-L87](https://github.com/a6984234/Andy-Bitfinex-Loan-Bot/blob/bce324a/AutoLending-Bitfinex/Program.cs#L84-L87)）。策略非常接近本專案早期的 `funding-auto-renew-2`：

**利率**（`GetAvg` [L105-L130](https://github.com/a6984234/Andy-Bitfinex-Loan-Bot/blob/bce324a/AutoLending-Bitfinex/Program.cs#L105-L130)）：抓過去 12 小時的 `fUSD` 30 分鐘 K 線（`fundingPeriod: "p2"`），取 `HighPrice` 最高的 11 根算平均。再抓過去 30 分鐘成交紀錄，若最新成交價 > 均值就改用最新成交價。低於 `LowestPrice`（預設 0.00025/日）就用下限。

**期間**（`SetPeriod` [L131-L137](https://github.com/a6984234/Andy-Bitfinex-Loan-Bot/blob/bce324a/AutoLending-Bitfinex/Program.cs#L131-L137)）：`< 0.0003` → 2 天；`< 0.0004` → 7 天；否則 30 天。

**金額切分**（[L56-L60](https://github.com/a6984234/Andy-Bitfinex-Loan-Bot/blob/bce324a/AutoLending-Bitfinex/Program.cs#L56-L60)）：`UnitAmount`（預設 150）為一單；餘額扣掉 `SetAsideFunds`（預留資金）後，一次只掛一張 `UnitAmount`（或剩餘全額）。沒有梯度。

**重掛時機**（`GetActiveFundingOffersCount` [L90-L103](https://github.com/a6984234/Andy-Bitfinex-Loan-Bot/blob/bce324a/AutoLending-Bitfinex/Program.cs#L90-L103)）：已有掛單時，只有在「新算出的利率（6 位小數）≠ 現有掛單利率」才 `CancelAllFundingOffers` 重掛。這點比本專案更省——利率沒變就不動單，保住 FIFO 排隊位置。

---

### liverpool1026/funding_bot

Python（REST 輪詢）、~10★、最後 commit 2021-03（`bcec975`）。每 5 秒一輪（[`funding_bot/bot/runner.py` L223](https://github.com/liverpool1026/funding_bot/blob/bcec975/funding_bot/bot/runner.py#L223)）。

**利率**（`Tracker.determine_offer_rate` [`funding_bot/bot/tracker.py` L90-L102](https://github.com/liverpool1026/funding_bot/blob/bcec975/funding_bot/bot/tracker.py#L90-L102)）：抓 `trade:5m` / `trade:30m` 的 funding K 線（`p2`），回傳 `candle.high × 0.99`。首次掛單用 30 分鐘窗的 high，重掛時用 5 分鐘窗的 high（更貼近當下、比較容易成交）。下限由 `get_minimum_daily_lending_rate` 提供（設定的年化 ÷ 36500）。

**期間**（`Account.generate_lending_offer` [`funding_bot/bot/account.py` L151-L176](https://github.com/liverpool1026/funding_bot/blob/bcec975/funding_bot/bot/account.py#L151-L176)）：年化 `>30%` → 30、`>25%` → 20、`>20%` → 10、`>15%` → 5、否則 2。

**金額切分**：不切分，一次掛一張（可動用餘額全額）。有個小技巧（[account.py L167-L168](https://github.com/liverpool1026/funding_bot/blob/bcec975/funding_bot/bot/account.py#L167-L168)）：當「餘額 > 2×最小額」且「年化 < 15%」時，只掛最小額 `MIN_FUNDING_AMOUNT`（USD 50）——低利率時不 all-in，留錢等好價。`get_funding_for_offer` [account.py L132-L146](https://github.com/liverpool1026/funding_bot/blob/bcec975/funding_bot/bot/account.py#L132-L146) 用 `maximum_lending_amount` 扣掉已放 + 掛單中的量做總量控制。

**重掛時機**（[`runner.py` L125-L182](https://github.com/liverpool1026/funding_bot/blob/bcec975/funding_bot/bot/runner.py#L125-L182)）：掛單後每張單追蹤，**超過 1 小時**還沒成交就取消，用 5 分鐘窗 high 重算後重掛。

**特殊功能**：初始餘額記在 AWS DynamoDB，Telegram 每小時回報 ROI／年化 ROI。

---

### cryptic-core/bf-lending-bot

Python（官方 `bfxapi`）、~6★、最後 commit 2026-02（`6dbaf02`），每分鐘跑一次（[`start.py` L228](https://github.com/cryptic-core/bf-lending-bot/blob/6dbaf02/start.py#L228)）。

**市場資料**（`get_market_funding_book` [L28-L80](https://github.com/cryptic-core/bf-lending-bot/blob/6dbaf02/start.py#L28-L80)）：抓 5 頁 funding book，把 offer 依天期分四桶（2 / 30 / 60 / 120），各算「量加權平均利率」`rate_avg` 和「最高利率」`rate_upper`。

**借款情緒**（`get_market_borrow_sentiment` [L83-L100](https://github.com/cryptic-core/bf-lending-bot/blob/6dbaf02/start.py#L83-L100)）：抓 `funding/stats` 歷史，`sentiment = 今日已用融資量 / 過去 12 小時平均`。市場越 FOMO 值越高。

**利率**（`guess_funding_book` [L104-L118](https://github.com/cryptic-core/bf-lending-bot/blob/6dbaf02/start.py#L104-L118)）：`rate_guess_upper = rate_avg × (1 + (rate_adjustment_ratio-1)×STEPS) × sentiment_ratio`（預設 `rate_adjustment_ratio=1.1`、`STEPS=10`、`highest_sentiment=5`）。

**鋪單**（`place_lending_offer` [L150-L190](https://github.com/cryptic-core/bf-lending-bot/blob/6dbaf02/start.py#L150-L190)）：目前 `margin_split_ratio_dict = {2:1.0, 30:0, 60:0, 120:0}`——**全押 2 天**。在 `[rate_avg, rate_guess_upper]` 之間等距切 `STEPS`（10）階，每階金額 `max(MINIMUM_FUNDS=150, 該天期比例 × 總資金 / STEPS)`，逐張掛出直到剩餘 < 150。

**期間**：由 `margin_split_ratio_dict` 的鍵決定（現況只有 2 天）。

**重掛時機**：每輪 `cancel_all_funding_offers` 全取消再重鋪。

---

### drodil/bitfinex_bot（釐清：非放貸）

Python、~9★、最後 commit 2021-04。曾被本專案 README 列入，但 [`bot.py`](https://github.com/drodil/bitfinex_bot/blob/master/bot.py) 是**現貨買賣**機器人（`coin_pairs = ['btcusd', ...]`、`new_order(... "buy"/"sell" ...)`、技術指標打分決定進出場），完全沒有 funding / lending 邏輯。已從 README 參考清單移除。

### MMquant/BFX-lending-bot（本專案分位法的鼻祖，2015）

MATLAB、~7★、最後 commit 2017-07（`eefc669`），作者 Petr Javorik，配套部落格 `mmquant.net/liquidity-lending-bfx`。設計成 cron 定期跑。**這支的核心思路和本專案 `funding-auto-renew-2/3` 幾乎一模一樣**，只是本專案用「成交量分位」、它用「離線算好的量門檻」：

**離線門檻計算**（[`threshold_calc.m`](https://github.com/MMquant/BFX-lending-bot/blob/eefc669/threshold_calc.m)）：讀過去 10 天的成交紀錄（`lastSwapsUSD.csv`），每 30 分鐘一桶加總成交量，取這些量的 1%~50% 分位。再用**白努利公式**算「在某分位掛單、兩次嘗試內至少成交一次」的機率，挑出機率 > 0.85 的最大量當 `threshold`（[L62-L77](https://github.com/MMquant/BFX-lending-bot/blob/eefc669/threshold_calc.m#L62-L77)）。

**掛單腳本**（[`lending_script.m` L98-L122](https://github.com/MMquant/BFX-lending-bot/blob/eefc669/lending_script.m#L98-L122)）：
1. 取消所有既有 offer（要「新鮮利率」）。
2. `unused_funds = deposit_balance − total_funds_lent`；> `threshold_bal`（52 USD）才放。
3. 掛在「lend book 累積量首度 **低於** `vol_threshold` 的那一檔利率」；若最低檔都超過門檻就用最低檔利率。
4. **期間**（[L116-L119](https://github.com/MMquant/BFX-lending-bot/blob/eefc669/lending_script.m#L116-L119)）：利率 `>= 20%`（年化）→ 30 天，否則 2 天。
5. 一次掛一張（`unused_funds − 0.1` 全額）。

log 裡還會記 `rate_wmean × 0.85`（乘 0.85 = 扣掉 Bitfinex 15% 平台費後的實得），這個「× 0.85」慣例在下面幾支新機器人也看得到。

### hankwu0501/bitfinex-lending-bot（Hybrid：階梯 + cascade + FRR 常駐單）

JS/TS、0★、最後 push 2026-06（`1b6fa92`）。從 huaying fork 後重寫，用 launchd 排程。核心在 [`server/strategy-hybrid.js`](https://github.com/hankwu0501/bitfinex-lending-bot/blob/1b6fa92/server/strategy-hybrid.js) + [`run-hybrid.js`](https://github.com/hankwu0501/bitfinex-lending-bot/blob/1b6fa92/run-hybrid.js)。

**baseRate**（`splitHybrid` [L116-L118](https://github.com/hankwu0501/bitfinex-lending-bot/blob/1b6fa92/server/strategy-hybrid.js#L116-L118)）：`max(FLOOR_DAILY, FRR × FRR_FACTOR, bookRate@50k)`。`FRR_FACTOR` 預設 0.95（掛在 FRR 稍下方），`FLOOR_DAILY` ≈ 0.000261（年化 10%），`bookRate` 是走 funding book 累積到 5 萬 USD 深度的利率（[`fetchBookDepthRate` L62-L72](https://github.com/hankwu0501/bitfinex-lending-bot/blob/1b6fa92/server/strategy-hybrid.js#L62-L72)）。

**8 層階梯**（[L206-L250](https://github.com/hankwu0501/bitfinex-lending-bot/blob/1b6fa92/server/strategy-hybrid.js#L206-L250)）：每層利率 = `baseRate × TIER_RATE_MULTIPLIERS[i]`（實際值 `[1, 1.02, 1.05, 1.08, 1.12, 1.2, 1.3, 1.45]`）；每層金額依 `TIER_WEIGHTS`（`[2.5, 2.5, 0, 0, 0, 1.5, 2, 2.5]`——**啞鈴型**，錢集中在頭尾兩端，中間三層權重 0）。資金不夠鋪滿時，`adaptive collapse`（[L155-L179](https://github.com/hankwu0501/bitfinex-lending-bot/blob/1b6fa92/server/strategy-hybrid.js#L155-L179)）從權重最小的層開始砍，直到每層 ≥ API 下限 150 USD。

**Cascade**（`cascadeEffectiveMult` [L85-L91](https://github.com/hankwu0501/bitfinex-lending-bot/blob/1b6fa92/server/strategy-hybrid.js#L85-L91)）：最頂 `CASCADE_TOP_N`（2）層，隨「未成交時數 / `CASCADE_HOURS`(3)」把倍率從起始值**線性降到** `CASCADE_FLOOR_MULTS`（`[1.15, 1.1]`）。有新成交就重置計時（`run-hybrid.js` [L169-L172](https://github.com/hankwu0501/bitfinex-lending-bot/blob/1b6fa92/run-hybrid.js#L169-L172)）；超過 `CASCADE_RESET_HOURS`(48) 完全沒成交就硬重置。

**FRR 常駐單**（[L213-L232](https://github.com/hankwu0501/bitfinex-lending-bot/blob/1b6fa92/server/strategy-hybrid.js#L213-L232)）：最底 `FRR_LEG_TIERS` 層用 Bitfinex 原生 `FRRDELTAVAR`（delta=0）掛單——自動追蹤 FRR、永遠不用取消、保住 FIFO 位置。`run-hybrid.js` 會偵測 book 裡已有的 FRRDELTAVAR 不重複疊加（[L129-L141](https://github.com/hankwu0501/bitfinex-lending-bot/blob/1b6fa92/run-hybrid.js#L129-L141)）。

**智慧重掛**（`run-hybrid.js` [L74-L116](https://github.com/hankwu0501/bitfinex-lending-bot/blob/1b6fa92/run-hybrid.js#L74-L116)）：**不是全取消**。先偷看新的 baseRate，只取消「利率 < `KEEP_FLOOR_MULT × baseRate`」或「掛超過 `OFFER_MAX_AGE_HOURS`(6)」的單；高利率單留著保 FIFO 位置。FRRDELTA 單永遠留。

**期間**（`pickPeriod` [L39-L45](https://github.com/hankwu0501/bitfinex-lending-bot/blob/1b6fa92/server/strategy-hybrid.js#L39-L45)）：年化比對 `PERIOD_BY_APR`（`[[0.2,10],[0.15,5],[0.12,3],[0,2]]`）。

**特殊功能**：`probe-actual-yield.js` / `probe-churn-cost.js` / `probe-disappear.js` 三支探針量測「重掛成本」「掛單消失率」；Telegram 只在有成交／錯誤／baseRate 變動 >2pp 時通知；報表含「已部署利用率 vs 已媒合利用率」「加權 APR vs 有效 APR」，並換算台幣月收。

### ipmman/lending-bot（三階段狀態機）

Python（WebSocket）、~1★、最後 push 2026-07（`29912af`）。有中英文 README。核心：[`code/rate_calculator.py`](https://github.com/ipmman/lending-bot/blob/29912af/code/rate_calculator.py) + `code/main.py`（660 行主迴圈）。

**三階段循環**（[README.zh-TW.md](https://github.com/ipmman/lending-bot/blob/29912af/README.zh-TW.md)）：

1. **FRR 模式**（預設）：`FRR × 0.98` 掛單（`FRR_RATE_DISCOUNT`）。若 `book_rate × 0.99 > FRR × 0.98` 則改用盤口價（`calculate_rate` [L37-L55](https://github.com/ipmman/lending-bot/blob/29912af/code/rate_calculator.py#L37-L55)）。掛 1 分鐘（`FRR_ORDER_TIMEOUT`）沒中算一次失敗，連 3 次（`FRR_FAILURE_THRESHOLD`）→ 進 Active 模式。
2. **Active 模式**：`book_rate × 0.99` 直接搶排隊第一，只等 10 秒（`ACTIVE_ORDER_TIMEOUT`）。成交 → 回 FRR 模式；連 6 次（`ACTIVE_MAX_ATTEMPTS`）沒中 → 熔斷。
3. **熔斷**：暫停 60 秒（`CIRCUIT_BREAKER_DURATION`），重置計數器回 FRR 模式。

**下限**：`MINIMUM_RATE` 預設 `7.0588`%——註解寫明是「目標淨 6% ÷ 0.85（扣 15% 平台費）」（[`config.py`](https://github.com/ipmman/lending-bot/blob/29912af/code/config.py)）。

**smart 模式**（`calculate_smart_rate` [L59-L99](https://github.com/ipmman/lending-bot/blob/29912af/code/rate_calculator.py#L59-L99)，目前未接上）：抓 `1m` K 線算 Q1/median/Q3 與波動率，高波動用保守值 `(median+Q1)/2`、低波動用 `((median+Q1)/2 + (median+Q3)/2)/2`，再和 FRR 以 55/45 權重混合。

**金額切分 / 期間**：README 未著墨，主要靠模式切換而非鋪多張單。訂閱 `book R0`（逐筆）+ `candles 1m:p2` + `ticker`。

### allen032062/bitfinex-funding-bot（波動率狀態機 + 回測框架）

Python、0★、最後 push 2026-08（`4206164`）。全中文註解。核心：[`strategy_engine.py`](https://github.com/allen032062/bitfinex-funding-bot/blob/4206164/strategy_engine.py) + [`funding_logic.py`](https://github.com/allen032062/bitfinex-funding-bot/blob/4206164/funding_logic.py) + [`backtester.py`](https://github.com/allen032062/bitfinex-funding-bot/blob/4206164/backtester.py)。

**狀態機**（`_decide_state` [`strategy_engine.py` L269-L300](https://github.com/allen032062/bitfinex-funding-bot/blob/4206164/strategy_engine.py#L269-L300)），每 10 秒評估一次：

| 狀態 | 觸發條件 | 掛單（`_calculate_plan` [L345-L413](https://github.com/allen032062/bitfinex-funding-bot/blob/4206164/strategy_engine.py#L345-L413)） |
| --- | --- | --- |
| `FRR_BOTTOM` | 波動率 < 15% | `FRR × 1.10`，300 USD，2 天 |
| `LADDER` | 波動率 > 40% | `(FRR + wall_rate)/2`，300 USD，7 天 |
| `GRAB_WALL` | 中波動且牆單量 ≥ 1000 且 wall_rate > FRR | `wall_rate × 0.98`，取牆量 30%（150~300），2 天 |
| `WATCH` | 其餘 | 不掛單 |

**安全網**：Hard Floor = `max(FRR, 年化10%/365)`，算出的利率低於此就抬上來（[L398-L402](https://github.com/allen032062/bitfinex-funding-bot/blob/4206164/strategy_engine.py#L398-L402)）；狀態切換時觸發撤單、但有 30 秒冷卻（[L306-L339](https://github.com/allen032062/bitfinex-funding-bot/blob/4206164/strategy_engine.py#L306-L339)）。

**階梯掛單**（`funding_logic.py`）：`get_initial_rate` = `max(年化10%/365, FRR/365 − 0.00001)`（[L52-L72](https://github.com/allen032062/bitfinex-funding-bot/blob/4206164/funding_logic.py#L52-L72)）；`get_period`（[L74-L98](https://github.com/allen032062/bitfinex-funding-bot/blob/4206164/funding_logic.py#L74-L98)）年化 >14.5% → 120 天、>12% → 7 天、否則 2 天；`calculate_ladder_amounts`（[L128-L174](https://github.com/allen032062/bitfinex-funding-bot/blob/4206164/funding_logic.py#L128-L174)）每 500 USD 一張、尾單 <150 併入前一張；`calculate_adjusted_rate`（[L101-L121](https://github.com/allen032062/bitfinex-funding-bot/blob/4206164/funding_logic.py#L101-L121)）掛久沒中時每次降 0.01%。掛單過期 2 小時（`OFFER_EXPIRE_HOURS`）自動取消重掛。

**回測框架**（`backtester.py`）：載入歷史 K 線 → 用波動率合成 funding 市場快照 → 逐根餵給策略函數 → 算總報酬、年化、Sharpe、Sortino、Calmar、最大回撤、勝率、盈虧比。內建 4 個策略工廠（frr_bottom / ladder / wall_grab / momentum）可橫向比較。**這是目前唯一看到有完整回測的專案。**

### Kenblair1226/bitfinex_lending_bot

Python、0★、最後 commit 2026-02（`49be6b1`）。看過 [`monitor.py`](https://github.com/Kenblair1226/bitfinex_lending_bot/blob/49be6b1/monitor.py) 後判斷：**以監控 + Telegram 通知為主**（追蹤既有 offer / credit 的利率、金額變動），主動掛單策略很薄。參考價值低。

### mingchengchen/BitfinexFundingBot

Python（WebSocket v2）、~3★、最後 commit 2021-01（`a6bc433`）。[`funding_bot.py`](https://github.com/mingchengchen/BitfinexFundingBot/blob/a6bc433/funding_bot.py) 全部邏輯在 `make_offer_decision` [L208-L230](https://github.com/mingchengchen/BitfinexFundingBot/blob/a6bc433/funding_bot.py#L208-L230)：訂閱 funding ticker，直接抄 ticker 回傳的「最新成交 bid 利率 / bid 天期」當自己的掛單參數；閒置 USD ≥ 50 就掛一張最小額單；掛超過 120 秒（`max_offer_pending_time`）未成交就取消。極簡，無下限保護、無梯度、無期間邏輯。

### yk-study「免費 Bitfinex 放貸機器人」（Google Apps Script）

部落格教學（2022-06，`yk-study.com/2022/06/29/666-2/`），程式跑在 Google Apps Script（免費、雲端定時觸發）。README 也連到本專案作者做的 [程式碼備份 gist](https://gist.github.com/taichunmin/0ee4820e3a2cfa9775522baa500dd2d5)（該 gist 只含 API wrapper，策略在共用的 Apps Script 專案裡）。

依搜尋摘要，`user_settings` 每個幣別是一組參數陣列，例如 `[20, 1000*10000, 2, 0.07, false]`：
- `20`：用 20% 總資金掛這一張單（百分比分批）。
- `1000*10000`：在 order book 累積到這個量（1000 萬）時取該檔利率。
- `2`：出借天數。
- `0.07`：最低利率（年化 7%）——累積量對應利率低於此就掛 7%。
- `false`：（推測為某個開關，如是否複投/隱藏）。

即「百分比分批 + order book 累積量門檻取利率 + 最低利率保底」，思路和本專案相近但用掛單簿深度而非成交量。教學特別提醒新手先把天數設 2、單筆上限設 150 USD 避免誤放大額長單。來源：[YK 的簡單投資](https://yk-study.com/2022/06/29/666-2/)、[FULY.AI 放貸教學（Medium）](https://medium.com/fuly-ai-%E6%99%BA%E8%83%BD%E6%8A%95%E8%B3%87%E7%AD%96%E7%95%A5%E6%A9%9F%E5%99%A8%E4%BA%BA-bitfinex-%E6%94%BE%E8%B2%B8%E6%A9%9F%E5%99%A8%E4%BA%BA)。

### 疑似衍生／複製本專案的 repo（未逐一分析）

GitHub 搜尋出現多個描述與本專案高度雷同（「每 10 分鐘自動調整利率、每日 Telegram 收益報表」）的新 repo，多為 fork 或改寫，策略邏輯應與本專案同源，價值有限：
`aa85192/bitfinex-lending-bot-v2`、`WaiXuan/BitfinexLendingBot`、`yoyitowang/bitfinex-lending-bot`、`ChiJiun/bitfinex-lending-bot`、`Frisk0316/Bitfinex-Lending-Bot`、`adad09382/BitfinexLendingBot`、`snroptimus/BitfinexLendingBot`、`milkshake0721/Bitfinex_Lending_Bot`、`huangchihwei0412-eng/bitfinex-lending-bot`。

### SaaS 服務公開講的策略

- **Coinlend**（`coinlend.org`）：宣稱 AI 演算法即時最佳化，收 5% 績效費。公開資訊只到「依 FRR 與市場狀況動態調整、可設 gap 與 threshold」的程度，演算法不公開。
- **Fuly.ai / FULY 富利學院**：中文圈最常見的商業放貸機器人，教學文提「年化 15~50%」「自動依市場調整掛單利率」，細節不公開。
- **lendingify.com**：本專案 README 已列，主打一鍵放貸，策略細節不公開。
- **cryptolend.net**：同類 SaaS，公開資訊少。

---

## 可借鏡的策略點子（對照本專案）

以下是「別人在做、本專案 `funding-auto-renew-3` 沒做」而且值得評估的點：

1. **梯度／階梯掛單（spread / ladder）**——幾乎每支有規模的機器人都做（MikaLendingBot、eAndrius MarginBot、huaying、instabot42、hankwu0501、allen032062、cryptic-core）。把資金分成 N 張、利率由低到高鋪開，能同時吃到「當前市價快速成交」和「利率尖峰」。本專案目前把所有錢交給單一 auto-renew 利率，錯過尖峰。可先做最簡單版：`rank` 附近取一個利率帶，鋪 3~5 張。

2. **FRR 為底 + offset**——eAndrius CascadeBot（`FRR + 增量`）、MikaLendingBot（`frrasmin` + `frrdelta`）、instabot42（`FRR × 倍率`）、ipmman（`FRR × 0.98`）、hankwu0501（`FRR × 0.95`）、allen032062（`FRR × 1.10`）。FRR 是 Bitfinex 官方公布的市場加權參考利率，拿它當浮動基準比純看歷史 K 線更貼近「現在借得掉的價」。本專案完全沒用到 FRR。

3. **原生 FRRDELTAVAR 常駐單**——hankwu0501 用 Bitfinex 原生的浮動利率單（delta=0 追蹤 FRR）當「保底腿」：永不需要取消、永久保住 FIFO 排隊位置、零重掛成本。本專案每次利率一變就取消全部 offer，會一直掉到隊尾。至少可以留一部分本金用 FRRDELTAVAR。

4. **智慧重掛：利率沒變就不動單**——a6984234（利率 6 位小數沒變就不重掛）、hankwu0501（只砍低於門檻或太舊的單，高價單留著）。本專案「設定有變就取消該幣別所有 offer」偏激進，市場小幅波動時會反覆重掛、每次都掉到隊尾。可加一個「利率變動 < X% 就不動」的死區。

5. **閒置資金 / 分段放貸上限**——MikaLendingBot（`maxtolend` / `maxpercenttolend` 搭 `maxtolendrate`）、eAndrius（`MaxActiveAmount`）、liverpool1026（低利率時只掛最小額）、eAndrius HighHold（保留一筆只在高價成交）。核心概念：**市場利率低的時候不要 all-in**，留現金等尖峰。本專案 `amount` 是固定值，沒有「利率低→少放」的機制。

6. **市場狀態機 / 波動率分流**——allen032062（波動率 <15% / >40% 切策略）、ipmman（FRR→Active→熔斷三階段）、MikaLendingBot MACD。低波動時穩穩掛 FRR、高波動時積極鋪階梯或搶牆，比單一參數更能適應行情。

7. **搶牆（grab wall）**——allen032062：偵測 order book 上的大額掛單（牆），掛在牆前 `wall_rate × 0.98`，吃掉會撞牆的大借款單。本專案的分位法某種程度會靠近牆，但沒有顯式偵測。

8. **回測框架**——只有 allen032062 有完整回測（K 線 → 合成 funding 市場 → 逐根跑策略 → Sharpe/回撤/勝率）。本專案有 `bin/__fixtures__/` K 線快照當 regression anchor，但沒有「策略績效回測」。要調 `rank` / `rateMin` / `period` 表時，回測比實盤試錯快得多。

9. **逾時重掛用更短的市場窗**——liverpool1026：首掛用 30 分鐘 K 線 high，重掛改用 5 分鐘 high（更貼現況、更容易成交）。本專案固定用「過去一天」的窗，重掛時沒有變更積極。

10. **扣平台費後的「實得利率」口徑**——MMquant、ipmman、hankwu0501 都把利率 `× 0.85`（Bitfinex 收 15%）當實際比較基準，`MINIMUM_RATE` 也是「目標淨利率 ÷ 0.85」回推。本專案的 `rateMin` 是毛利率，設定時要自己心算。文件或計算裡標註淨利率會更直覺。

11. **金額也做梯度（非等分）**——huaying 金字塔（金額 `× 1.4^i` 遞增）、hankwu0501 啞鈴型權重（頭尾重、中間 0）。等分是最簡單的，但「越高價的單放越多錢」或「頭尾重壓」在特定行情下期望值更高。

---

## 參考連結

**GitHub**
- <https://github.com/BitBotFactory/MikaLendingBot>
- <https://github.com/eAndrius/BitfinexLendingBot>
- <https://github.com/huaying/bitfinex-lending-bot>
- <https://github.com/instabot42/funding-bot>
- <https://github.com/a6984234/Andy-Bitfinex-Loan-Bot>
- <https://github.com/liverpool1026/funding_bot>
- <https://github.com/cryptic-core/bf-lending-bot>
- <https://github.com/MMquant/BFX-lending-bot>（配套文章 `mmquant.net/liquidity-lending-bfx`）
- <https://github.com/hankwu0501/bitfinex-lending-bot>
- <https://github.com/ipmman/lending-bot>
- <https://github.com/allen032062/bitfinex-funding-bot>
- <https://github.com/Kenblair1226/bitfinex_lending_bot>
- <https://github.com/mingchengchen/BitfinexFundingBot>
- <https://github.com/drodil/bitfinex_bot>（非放貸，現貨交易機器人）

**文章／教學／SaaS**
- 用 AI 寫 Bitfinex 放貸機器人（marco79423）：<https://marco79423.net/articles/隨手記-用-ai-寫-bitfinex-放貸機器人>
- 放貸機器人介紹（evestment）：<https://evestment.weebly.com/marginbotintro.html>
- YK 免費 Bitfinex 放貸機器人（Google Apps Script）：<https://yk-study.com/2022/06/29/666-2/>
- BFX 放貸機器人程式碼備份 gist：<https://gist.github.com/taichunmin/0ee4820e3a2cfa9775522baa500dd2d5>
- Coinlend FAQ：<https://www.coinlend.org/#!FAQ>
- lendingify：<https://lendingify.com/en>
- FULY.AI 放貸教學（Medium）：<https://medium.com/fuly-ai-智能投資策略機器人-bitfinex-放貸機器人>
- Bitfinex 官方 Margin Lending 說明：<https://blog.bitfinex.com/education/how-to-earn-with-margin-lending-on-bitfinex>
- 綠葉放貸教學影片：<https://www.youtube.com/watch?v=OL0cZabjl3U>
