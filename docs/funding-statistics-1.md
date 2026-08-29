# funding-statistics-1

計算 1／7／30／365 日的年化與資金利用率，發送 Telegram 報告，並輸出 CSV／JSON。

## Run

```bash
INPUT_CURRENCYS=USD,UST yarn tsx ./bin/funding-statistics-1.ts
```

## 輸出欄位

每日一列，寫進 `dist/funding-statistics-1/<currency>.{csv,json}`：

| 欄位 | 說明 |
| --- | --- |
| `interest` | 當日入帳利息（經濟意義是前一天賺的） |
| `balance` | 當日 funding 錢包餘額 |
| `investment` | 可投入本金 = `balance − interest` |
| `lentRatio1` | 當日資金利用率（%），時間加權放出金額 ÷ `investment` |
| `dpr` | 日報酬率（%） |
| `apr1` / `apr7` / `apr30` / `apr365` | 1／7／30／365 日年化（%），每日 `apr1` 的簡單平均 |
| `lentRatio7` / `lentRatio30` / `lentRatio365` | trailing N 日資金利用率（%），`Σ每日放出金額 ÷ Σ每日 investment`（加權平均，非簡單平均）|

- 利用率的分子含**進行中（ACTIVE）**的出借，由本腳本直接抓 `v2AuthReadFundingCredits()` 併入計算，不寫進 CSV。
- 當日大額入金時 `lentRatio*` 可能短暫 >100%，隔一兩天恢復；不夾百。
- 計算口徑詳見 [`../.claude/docs/adr/0001-lent-ratio-calculation.md`](../.claude/docs/adr/0001-lent-ratio-calculation.md)。

## Telegram 報告格式

```
# USD 放貸收益報告
日期: 2026-08-28
利息: 0.30460832 USD
  1日年化:   9.86% (利用率  94.64%)
  7日年化:   7.22% (利用率  93.84%)
 30日年化:   6.02% (利用率  79.50%)
365日年化:   7.22% (利用率  82.93%)
```

年化取 `dateMax`（利息 payout 日），利用率取 `dateMax − 1` 結尾的視窗（見 ADR-0001）。

## Links

- [綠葉放貸收益報告](https://lookerstudio.google.com/reporting/500aadf5-8d0d-4cba-a1ce-7275c7e5b21e)
  - [USD.json](https://taichunmin.idv.tw/bitfinex-lending-bot/funding-statistics-1/USD.json) [USD.csv](https://taichunmin.idv.tw/bitfinex-lending-bot/funding-statistics-1/USD.csv)
  - [UST.json](https://taichunmin.idv.tw/bitfinex-lending-bot/funding-statistics-1/UST.json) [UST.csv](https://taichunmin.idv.tw/bitfinex-lending-bot/funding-statistics-1/UST.csv)
- 歷史放貸記錄
  - [USD.csv](https://taichunmin.idv.tw/bitfinex-lending-bot/funding-export-credits-1/USD.csv)
  - [UST.csv](https://taichunmin.idv.tw/bitfinex-lending-bot/funding-export-credits-1/UST.csv)
