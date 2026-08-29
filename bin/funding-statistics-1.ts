/*
INPUT_CURRENCYS=USD,UST yarn tsx ./bin/funding-statistics-1.ts

計算 1/7/30/365 日年化與資金利用率，發送 Telegram 報告並輸出 CSV/JSON
*/

// import first before other imports
import { getenv } from '@/lib/dotenv'

import { dayjs } from '@/lib/dayjs'
import { floatFormatDecimal, writeFile } from '@/lib/helper'
import { createLoggersByUrl } from '@/lib/logger'
import * as telegram from '@/lib/telegram'
import { z } from '@/lib/zod'
import { Bitfinex, LedgersHistCategory, PlatformStatus } from '@taichunmin/bitfinex'
import _ from 'lodash'
import { promises as fsPromises } from 'node:fs'
import * as url from 'node:url'
import { inspect } from 'node:util'
import Papa from 'papaparse'

const loggers = createLoggersByUrl(import.meta.url)
const filename = new URL(import.meta.url).pathname.replace(/^.*?([^/\\]+)\.[^.]+$/, '$1')
const DB_KEY = `api:taichunmin_${filename}`
const outdir = new URL(`../dist/${filename}/`, import.meta.url)
const creditsOutdir = new URL('../dist/funding-export-credits-1/', import.meta.url)
const MS_PER_DAY = 24 * 60 * 60 * 1000
const bitfinex = new Bitfinex({
  apiKey: getenv('BITFINEX_API_KEY'),
  apiSecret: getenv('BITFINEX_API_SECRET'),
  affCode: getenv('BITFINEX_AFF_CODE'),
})

const ZodConfig = z.object({
  currencys: z.array(z.string().trim().regex(/^[\w:]+$/).toUpperCase()),
})

export async function main (): Promise<void> {
  const cfg = ZodConfig.parse({
    currencys: getenv('INPUT_CURRENCYS', '').split(','),
  })
  ymlDump('input', cfg)
  if ((await Bitfinex.v2PlatformStatus()).status === PlatformStatus.MAINTENANCE) {
    loggers.error('Bitfinex API is in maintenance mode')
    return
  }
  if (cfg.currencys.length === 0) {
    loggers.error('No currency specified')
    return
  }

  const tsToday = dayjs().startOf('day')
  const db = await fetchDb()
  ymlDump('db', db)

  // 進行中（ACTIVE）的借出：以 [mtsOpening, 現在] 併入每日放出金額計算，讓昨天的利用率在執行當下就是完整的
  const activeByCurr = _.groupBy(await bitfinex.v2AuthReadFundingCredits(), 'currency')

  for (const currency of cfg.currencys) {
    const lentAmountByDate = await calcLentAmountByDate(currency, activeByCurr[currency] ?? [])

    let payments = await bitfinex.v2AuthReadLedgersHist({
      category: LedgersHistCategory.MarginSwapInterestPayment,
      currency,
      limit: 2500,
    })
    payments = _.filter(payments, row => row.wallet === 'funding')
    payments = _.sortBy(payments, ['mts'])
    // ymlDump('payments', payments)

    const stats: Record<string, any> = {}
    let [dateMax, dateMin]: any[] = [null, null]
    const tplStat = (date: string) => ({ date, interest: 0, apr1: 0, apr7: 0, apr30: 0, apr365: 0, balance: null, dpr: 0, investment: null, lentRatio1: 0, lentRatio7: 0, lentRatio30: 0, lentRatio365: 0 })
    for (const payment of payments) {
      const date1 = dayjs(payment.mts).format('YYYY-MM-DD')
      dateMax = _.max([dateMax ?? date1, date1])
      dateMin = _.min([dateMin ?? date1, date1])

      const stat = stats[date1] ??= tplStat(date1)
      stat.balance = Math.max(stat.balance ?? 0, payment.balance)
      stat.interest += payment.amount
      stat.investment = _.round(stat.balance - stat.interest, 8)
      stat.dpr = stat.investment <= 0 ? 0 : stat.interest * 100 / stat.investment
      stat.apr1 = stat.dpr * 365

      for (let i = 0; i < 365; i++) {
        const ts2 = dayjs(date1).add(i, 'day')
        if (ts2 > tsToday) break
        const date2 = ts2.format('YYYY-MM-DD')
        if (i < 7) (stats[date2] ??= tplStat(date2)).apr7 += stat.apr1
        if (i < 30) (stats[date2] ??= tplStat(date2)).apr30 += stat.apr1
        ;(stats[date2] ??= tplStat(date2)).apr365 += stat.apr1
      }
    }
    let prevBalance = 0
    const orderedDates: string[] = []
    for (let ts2 = dayjs(dateMin); ts2 <= tsToday; ts2 = ts2.add(1, 'day')) {
      const date2 = ts2.format('YYYY-MM-DD')
      orderedDates.push(date2)
      const stat = stats[date2] ??= tplStat(date2)
      stat.investment ??= prevBalance
      stat.balance ??= prevBalance
      prevBalance = stat.balance
      const lentAmountByDay = lentAmountByDate[date2] ?? 0
      stat.lentRatio1 = stat.investment <= 0 ? 0 : _.round(100 * lentAmountByDay / stat.investment, 8)
      stat.apr7 /= 7
      stat.apr30 /= 30
      stat.apr365 /= 365
    }

    // trailing N 日的資金加權利用率：Σ(每日放出金額) / Σ(每日可投入本金)，分母用當日起始資金 investment[d]，前綴和加速
    let cumLent = 0
    let cumInvestment = 0
    const prefixLent = [0]
    const prefixInvestment = [0]
    for (const date2 of orderedDates) {
      cumLent += lentAmountByDate[date2] ?? 0
      cumInvestment += stats[date2].investment ?? 0
      prefixLent.push(cumLent)
      prefixInvestment.push(cumInvestment)
    }
    for (let i = 0; i < orderedDates.length; i++) {
      const stat = stats[orderedDates[i]]
      for (const n of [7, 30, 365]) {
        const lo = Math.max(0, i + 1 - n)
        const sumLent = prefixLent[i + 1] - prefixLent[lo]
        const sumInvestment = prefixInvestment[i + 1] - prefixInvestment[lo]
        stat[`lentRatio${n}`] = sumInvestment <= 0 ? 0 : _.round(100 * sumLent / sumInvestment, 8)
      }
    }
    // ymlDump('stats', stats)

    // stats[dateMax]
    if (dateMax !== db.latestDate2?.[currency]) { // 如果有更新才發送
      _.set(db, `latestDate2.${currency}`, dateMax)
      const stat2 = stats[dateMax]
      // 利用率取前一天結尾的視窗：dateMax 的利息其實是前一經濟日賺的，且 dateMax 當天只到執行時刻（約 00:45 UTC）
      const statLent = stats[dayjs(dateMax).subtract(1, 'day').format('YYYY-MM-DD')] ?? tplStat('')
      // 例：`  7日年化: 10.85% (利用率 99.50%)`，年化取 dateMax、利用率取 dateMax−1
      const aprLine = (days: number): string =>
        `${String(days).padStart(3)}日年化: ${floatFormatDecimal(stat2[`apr${days}`], 2).padStart(6)}% (利用率 ${floatFormatDecimal(statLent[`lentRatio${days}`], 2).padStart(6)}%)`
      await telegram.sendMessage({
        parse_mode: 'MarkdownV2',
        text: `\\# ${currency} 放貸收益報告
\`
日期: ${dateMax.replaceAll('-', '\\-')}
利息: ${floatFormatDecimal(stat2.interest, 8)} ${currency}
${[1, 7, 30, 365].map(aprLine).join('\n')}
\``,
      })
    }

    await writeFile(
      new URL(`${currency}.json`, outdir),
      JSON.stringify(_.values(stats), null, 2),
    )
    await writeFile(
      new URL(`${currency}.csv`, outdir),
      Papa.unparse(_.values(stats), { header: true }),
    )
  }

  ymlDump('newDb', db)
  await bitfinex.v2AuthWriteSettingsSet({ [DB_KEY]: ZodDb.parse(db) as any })
}

interface CreditCsvRow {
  amount?: string
  closedAt?: string
  id?: string
  openedAt?: string
  side?: string
}

interface FundingCredit {
  amount: number
  mtsOpening: Date
  side: number
}

/**
 * 每日「時間加權放出本金」：把每筆出借的金額，依其存續時間攤到每一個 UTC 日期。
 * 已關閉的出借讀自 `funding-export-credits-1` 匯出的 CSV；進行中（ACTIVE）的出借以 `[mtsOpening, 現在]` 併入，
 * 否則多為 2 天期、執行當下還開著的單會讓昨天的放出量嚴重低估。
 */
async function calcLentAmountByDate (currency: string, activeCredits: FundingCredit[]): Promise<Record<string, number>> {
  const filepath = new URL(`${currency}.csv`, creditsOutdir)

  const parsed = await (async () => {
    try {
      const csvData = await fsPromises.readFile(filepath, 'utf8')
      return Papa.parse<CreditCsvRow>(csvData, {
        header: true,
        skipEmptyLines: true,
      })
    } catch (err) {
      if (err.code !== 'ENOENT') loggers.error(inspect(err))
      return null
    }
  })()

  const results: Record<string, number> = {}

  const addSpan = (amount: number, openedAt: dayjs.Dayjs, closedAt: dayjs.Dayjs): void => {
    if (!(amount > 0) || !openedAt.isValid() || !closedAt.isValid() || !closedAt.isAfter(openedAt)) return

    for (let dayStart = openedAt.startOf('day'); dayStart.isBefore(closedAt); dayStart = dayStart.add(1, 'day')) {
      const dayEnd = dayStart.add(1, 'day')
      const overlapStart = Math.max(dayStart.valueOf(), openedAt.valueOf())
      const overlapEnd = Math.min(dayEnd.valueOf(), closedAt.valueOf())
      if (overlapEnd <= overlapStart) continue

      const date = dayStart.format('YYYY-MM-DD')
      const amountByDay = amount * (overlapEnd - overlapStart) / MS_PER_DAY
      results[date] = _.round((results[date] ?? 0) + amountByDay, 8)
    }
  }

  const seenIds = new Set<string>()
  for (const row of parsed?.data ?? []) {
    if (_.toSafeInteger(row.side) !== 1) continue
    const id = row.id ?? ''
    if (id !== '' && seenIds.has(id)) continue // funding-export-credits-1 的 CSV 偶有分頁重疊造成的重複列
    seenIds.add(id)
    addSpan(
      _.toFinite(row.amount),
      dayjs.utc(row.openedAt, 'YYYY-MM-DD HH:mm:ss', true),
      dayjs.utc(row.closedAt, 'YYYY-MM-DD HH:mm:ss', true),
    )
  }

  const now = dayjs.utc()
  for (const credit of activeCredits) {
    if (credit.side !== 1) continue
    addSpan(_.toFinite(credit.amount), dayjs.utc(credit.mtsOpening), now)
  }

  return results
}

function ymlDump (key: string, val: any): void {
  loggers.log({ [key]: val })
}

const ZodDb = z.object({
  schema: z.int().min(1).default(2), // 用來辨識資料結構版本，方便未來升級
  latestDate2: z.record(
    z.string(),
    z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish().catch(null),
  ).nullish().catch(null),
})

async function fetchDb (): Promise<z.output<typeof ZodDb>> {
  try {
    const db = (await bitfinex.v2AuthReadSettings([DB_KEY]))[DB_KEY.slice(4)]
    return ZodDb.parse(db ?? {})
  } catch (err) {
    if (err.status !== 404) loggers.error(inspect(err))
    return ZodDb.parse({})
  }
}

class NotMainModuleError extends Error {}
try {
  if (!_.startsWith(import.meta.url, 'file:')) throw new NotMainModuleError()
  const modulePath = url.fileURLToPath(import.meta.url)
  if (process.argv[1] !== modulePath) throw new NotMainModuleError()
  await main()
} catch (err) {
  if (!(err instanceof NotMainModuleError)) {
    loggers.error(inspect(err))
    process.exit(1)
  }
}
