# 資金利用率（lentRatio）的計算口徑

## 背景

`funding-statistics-1` 的每日 Telegram 報告要在每個年化數字後面加上對應天期的資金利用率（`1日年化: 12.52% (利用率 99.88%)`），並在 `USD.csv`／`USD.json` 補上 `lentRatio1/7/30/365` 欄位供 Looker Studio 使用。利用率的定義有多種合理算法，以下記錄選擇與取捨。

## 決策

1. **時間加權，而非簡單平均。**
   N 日利用率 = `Σ(每日時間加權放出金額) ÷ Σ(每日可投入本金) × 100%`，視窗為 trailing N 日、含當日（與 `apr7/30/365` 的視窗慣例一致）。
   沒有比照 `apr*` 用「每日數字的簡單平均」，因為利用率的本質是一個比率，加權平均才不會被「某天本金很小」的日子扭曲。`apr*` 維持簡單平均不動。

2. **分母用「當日起始資金」`investment[d]`，不夾 100%（B1）。**
   放款時能動用的是當天開始時的資金，最接近 `investment[d]`。改用隔天資金 `investment[d+1]`（多含一整天利息）會讓滿倉也永遠顯示 99.x%，系統性低估。
   代價：當日有大額入金時，分母滯後、利用率可能短暫超過 100%（實測 2024 年幾次入金日出現 124%～140%），隔一兩天自然恢復。選擇不 `Math.min(100, …)` 夾住，讓它忠實呈現。

3. **進行中（ACTIVE）的出借由 `funding-statistics-1` 自己抓，不落地。**
   `funding-export-credits-1` 只匯出已關閉的出借，而約 78% 的單是 2 天期、腳本執行（約 00:45 UTC）時還開著。若只算已關閉的單，昨天的放出量會嚴重低估。
   因此 `funding-statistics-1` 直接呼叫 `v2AuthReadFundingCredits()`，把 ACTIVE 出借以 `[mtsOpening, 現在]` 併入 `calcLentAmountByDate` 計算，**不**經過 `funding-export-credits-1`、**不**寫進任何 CSV。理由：ACTIVE 是易變的即時快照，寫進歷史 CSV 沒有意義，且會污染 Looker Studio 的歷史資料。

4. **利用率視窗整體往前一天。**
   報告錨定在 `dateMax`（利息 payout 日），但那筆利息是前一經濟日賺的，而 `dateMax` 當天只到執行時刻。因此利息／年化維持讀 `stats[dateMax]`，利用率四個數字改讀 `stats[dateMax−1]`。帳號史上所有利息都落在同一天（開帳頭一兩天）時 `stats[dateMax−1]` 不存在，退回顯示 0.00%，不特別處理。

5. **讀 CSV 時依 `id` 去重。**
   `funding-export-credits-1` 的去重只比對相鄰前一筆，分頁重疊 + 多幣別交錯時會漏，CSV 偶有重複列（實測 UST 曾因此某日利用率變成 199.99%）。在 `calcLentAmountByDate` 讀檔時用 `Set<id>` 擋掉，不動 `funding-export-credits-1`。

## 影響

- `USD.csv`／`USD.json` 的 `utilization` 欄改名為 `lentRatio1`。部署後需進 Looker Studio 把失效的欄位重新對應。
- 相關識別字改為 `lent*` 家族：`lentAmountByDay`、`lentAmountByDate`、`calcLentAmountByDate()`。
