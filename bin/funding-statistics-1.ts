/*
INPUT_CURRENCYS=USD,UST yarn tsx ./bin/funding-statistics-1.ts

計算昨日年化、七日年化、三十日年化
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

  for (const currency of cfg.currencys) {
    const utilizationByDate = await calcUtilizationByDate(currency)

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
    const tplStat = (date: string) => ({ date, interest: 0, balance: null, investment: null, utilization: 0, dpr: 0, apr1: 0, apr7: 0, apr30: 0, apr365: 0 })
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
    for (let ts2 = dayjs(dateMin); ts2 <= tsToday; ts2 = ts2.add(1, 'day')) {
      const date2 = ts2.format('YYYY-MM-DD')
      const stat = stats[date2] ??= tplStat(date2)
      stat.investment ??= prevBalance
      stat.balance ??= prevBalance
      prevBalance = stat.balance
      const utilizedAmountByDay = utilizationByDate[date2] ?? 0
      stat.utilization = stat.investment <= 0 ? 0 : _.round(100 * utilizedAmountByDay / stat.investment, 8)
      stat.apr7 /= 7
      stat.apr30 /= 30
      stat.apr365 /= 365
    }
    // ymlDump('stats', stats)

    // stats[dateMax]
    if (dateMax !== db.latestDate2?.[currency]) { // 如果有更新才發送
      _.set(db, `latestDate2.${currency}`, dateMax)
      const stat2 = stats[dateMax]
      await telegram.sendMessage({
        parse_mode: 'MarkdownV2',
        text: `\\# ${currency} 放貸收益報告
\`
日期: ${dateMax.replaceAll('-', '\\-')}
利息: ${floatFormatDecimal(stat2.interest, 8)} ${currency}
資金利用率: ${floatFormatDecimal(stat2.utilization, 2)}%
  1日年化: ${floatFormatDecimal(stat2.apr1, 2)}%
  7日年化: ${floatFormatDecimal(stat2.apr7, 2)}%
 30日年化: ${floatFormatDecimal(stat2.apr30, 2)}%
365日年化: ${floatFormatDecimal(stat2.apr365, 2)}%
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
  openedAt?: string
  side?: string
}

async function calcUtilizationByDate (currency: string): Promise<Record<string, number>> {
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
  if (_.isNil(parsed)) return {}

  const results: Record<string, number> = {}

  for (const row of parsed.data) {
    if (_.toSafeInteger(row.side) !== 1) continue
    const amount = _.toFinite(row.amount)
    if (amount <= 0) continue

    const openedAt = dayjs.utc(row.openedAt, 'YYYY-MM-DD HH:mm:ss', true)
    const closedAt = dayjs.utc(row.closedAt, 'YYYY-MM-DD HH:mm:ss', true)
    if (!openedAt.isValid() || !closedAt.isValid() || !closedAt.isAfter(openedAt)) continue

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
