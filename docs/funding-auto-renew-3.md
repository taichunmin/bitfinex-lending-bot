# funding-auto-renew-3 說明文件

## 概要

`bin/funding-auto-renew-3.ts` 會依據最近一天的融資市場資料，自動計算建議利率並更新 Bitfinex 的 auto-renew 設定。

核心目標：

1. 用最近一天的成交量推估一個「符合目標分位（rank）」的利率。
2. 依 `rateMin` / `rateMax` 限制最終利率。
3. 依利率計算出借天數（`period`）。
4. 套用 auto-renew 設定
5. 透過 Telegram 回報出借狀態。

## 放貸績效實測

均民自 2025/03/21 開始，分別在 USD 以及 UST 放了約 1000 美元的本金來實測放貸績效，詳細報告在此：

- [綠葉放貸收益報告](https://lookerstudio.google.com/reporting/500aadf5-8d0d-4cba-a1ce-7275c7e5b21e)
  - [USD.json](http://taichunmin.idv.tw/bitfinex-lending-bot/funding-statistics-1/USD.json) [USD.csv](http://taichunmin.idv.tw/bitfinex-lending-bot/funding-statistics-1/USD.csv)
  - [UST.json](http://taichunmin.idv.tw/bitfinex-lending-bot/funding-statistics-1/UST.json) [UST.csv](http://taichunmin.idv.tw/bitfinex-lending-bot/funding-statistics-1/UST.csv)

## 執行方式

GitHub Actions：

- 請參考 workflow：`.github/workflows/taichunmin-funding-auto-renew-3.yml`
- 排程定期觸發，避開整點

本地端開發單次執行：

```bash本地端
yarn tsx ./bin/funding-auto-renew-3.ts
```

## 需要的環境變數

必要：

- `BITFINEX_API_KEY`
- `BITFINEX_API_SECRET`
- `INPUT_AUTO_RENEW_3`：出借參數的設定（YAML）
- `TELEGRAM_CHAT_ID`：回報出借狀態的 Telegram 聊天室 ID
- `TELEGRAM_TOKEN`

本地端可先把 `.env.example` 複製為 `.env` 後修改相關設定

## Bitfinex API Key 最小權限需求

```json
{
  "account": { "read": false, "write": false },
  "history": { "read": true, "write": false },
  "orders": { "read": false, "write": false },
  "positions": { "read": false, "write": false },
  "funding": { "read": true, "write": true },
  "settings": { "read": true, "write": true },
  "wallets": { "read": true, "write": false },
  "withdraw": { "read": false, "write": false },
  "ui_withdraw": { "read": false, "write": false }
}
```

## INPUT_AUTO_RENEW_3 出借參數的設定

請將出借參數以 YAML 格式撰寫，並設定於環境變數 `INPUT_AUTO_RENEW_3` 中。

範例：

```yaml
USD:
  amount: 0
  rank: 0.8
  rateMax: 0.01
  rateMin: 0.0001
  period:
    3: 0.00027397
    7: 0.00041096
    21: 0.00068493
    30: 0.00082192
UST:
  amount: 0
  rank: 0.8
  rateMax: 0.01
  rateMin: 0.0001
  period:
    3: 0.00027397
    7: 0.00041096
    21: 0.00068493
    30: 0.00082192
```

欄位說明：

- `amount`: auto-renew 設定的金額，`>= 0`
- `rank`: 目標分位，範圍 `0 ~ 1`
- `rateMin`: 最低利率下限，最小值為 `0.0001`
- `rateMax`: 最高利率上限，最小值為 `0.0001`
- `period`: 天數對應利率的映射表，鍵值為 `2 ~ 120` 的整數天數

## 程式流程

每個幣別（例如 `USD`, `UST`）會依序執行：

1. 檢查平台是否維護中
2. 從 Bitfinex 讀取之前留下的資料
3. 讀取 funding wallet
4. 讀取該幣別目前 auto-renew 設定
5. 讀取最近一天 `1m` K 線（`v2CandlesHist`）
6. 計算目標利率（見下一節）
7. 套用 `rateMin/rateMax` 並換算 `period`
8. 若設定有變更：
    - 關閉舊 auto-renew（若存在）
    - 取消該幣別所有 funding offers
    - 寫入新 auto-renew
    - 等待 1 秒讓掛單生效
9. 產生出借狀態報告（投資額、已借出、掛單中、利率、APR、天數、credits 明細）
10. 依條件決定編輯舊訊息或發新訊息至 Telegram 聊天室
11. 在 Bitfinex 儲存這次執行的資料以便下次使用

## 利率計算演算法

### 1) 建立利率區間與成交量

從每根 K 線取：

- `low = min(open, close, high, low)`
- `high = max(open, close, high, low)`
- `volume`

全部放大 `1e8` 後轉成 `BigInt`，避免浮點誤差。

然後把相同 `[low, high]` 的區間合併，累加 `volume`。

### 2) 目標 rank

總成交量 `totalVolume = sum(volume)`。

目標分位由設定 `rank` 決定。

### 3) 二分搜尋目標利率

在 `[lowestRate, highestRate]` 上做二分搜尋。對每個中點 `mid`，計算其對應累積成交量 `midVol`：

- 若 `mid >= high`，該區間量全計入
- 若 `mid < low`，該區間不計入
- 若落在中間，按比例線性切分

接著計算 `midRank = midVol / totalVolume`，與目標 `rank` 比較。

過程中會保留「目前最接近目標 rank 的 mid」作為 `targetRate`，即使沒精準命中也有最接近解。

### 4) 套用上下限

最終利率：

```text
targetRate = clamp(targetRate, rateMin, rateMax)
```

## `rateToPeriod` 邏輯

`rateToPeriod(periodMap, rateTarget)` 會從 `period` 映射中找出：

- `lower`: 利率小於等於目標利率時，最大的天數
- `upper`: 利率大於等於目標利率時，最小的天數

決策規則：

1. 若沒有 `lower`，回傳 `2`
2. 若沒有 `upper`，回傳 `lower`
3. 若 `lower === upper`，回傳該天數
4. 否則在 `lower` 與 `upper` 之間做線性插值，再無條件捨去
5. 最後再 `clamp` 到 `2 ~ 120`

## Telegram 訊息重用條件

程式會嘗試編輯舊訊息（避免重複洗版），只有以下條件同時成立才重用：

1. 先前有 `msgId`
2. funding wallet `balance` 未改變
3. 出借中的 `creditIds` 未改變

否則就發送新訊息，並更新 `db.notified[currency]`。

## GitHub Actions 設定重點

workflow `taichunmin-funding-auto-renew-3.yml`：

1. 排程每 10 分鐘觸發
2. 鎖定 repository owner 避免被 fork 時誤觸發
3. 使用 environment: `taichunmin-funding-auto-renew-3`
4. 步驟包含：
    - keepalive
    - checkout
    - setup-node（`lts/*`）
    - `yarn`
    - `yarn lint`
    - `yarn tsx ./bin/funding-auto-renew-3.ts`

## 實務建議

1. `rank` 建議先從 `0.6 ~ 0.85` 區間測試，再依實際成交與收益調整。
2. `rateMin` 不宜設太高，避免在市場走低時長時間掛不出去。
3. `period` 映射建議維持單調（天數越長，利率門檻越高），可降低插值結果不直覺的情況。
4. 若要加新幣別，只要在 `INPUT_AUTO_RENEW_3` 增加同結構配置即可。
