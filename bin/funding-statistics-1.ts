/*
INPUT_CURRENCYS=USD,UST yarn tsx ./bin/funding-statistics-1.ts

計算昨日年化、七日年化、三十日年化
*/

// import first before other imports
import { getenv } from '../lib/dotenv.mjs'

import { Bitfinex, LedgersHistCategory, PlatformStatus } from '@taichunmin/bitfinex'
import axios from 'axios'
import _ from 'lodash'
import { promises as fsPromises } from 'node:fs'
import * as url from 'node:url'
import { inspect } from 'node:util'
import { z } from 'zod'
import { dayjs } from '../lib/dayjs.mjs'
import { floatFormatDecimal } from '../lib/helper.mjs'
import { createLoggersByUrl } from '../lib/logger.mjs'
import * as telegram from '../lib/telegram.mjs'
import Papa from 'papaparse'

const loggers = createLoggersByUrl(import.meta.url)
const filename = new URL(import.meta.url).pathname.replace(/^.*?([^/\\]+)\.[^.]+$/, '$1')
const outdir = new URL(`../dist/${filename}/`, import.meta.url)
const bitfinex = new Bitfinex({
  apiKey: getenv('BITFINEX_API_KEY'),
  apiSecret: getenv('BITFINEX_API_SECRET'),
  affCode: getenv('BITFINEX_AFF_CODE'),
})

function ymlDump (key: string, val: any): void {
  loggers.log(_.set({}, key, val))
}

const ZodConfig = z.object({
  currencys: z.array(z.string().trim().regex(/^[\w:]+$/).toUpperCase()),
  db: z.string().url(),
})

export async function main (): Promise<void> {
  const cfg = ZodConfig.parse({
    currencys: getenv('INPUT_CURRENCYS', '')?.split(','),
    db: getenv('INPUT_DB', `http://taichunmin.idv.tw/bitfinex-lending-bot/${filename}/db.json`),
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
  const db = await fetchDb(cfg.db)
  ymlDump('db', db)

  for (const currency of cfg.currencys) {
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
    const tplStat = date => ({ date, interest: 0, balance: null, investment: null, dpr: 0, apr1: 0, apr7: 0, apr30: 0, apr365: 0 })
    for (const payment of payments) {
      const date1 = dayjs(payment.mts).format('YYYY-MM-DD')
      dateMax = _.isNil(dateMax) || date1 > dateMax ? date1 : dateMax
      dateMin = _.isNil(dateMin) || date1 < dateMin ? date1 : dateMin

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
      stat.apr7 /= 7
      stat.apr30 /= 30
      stat.apr365 /= 365
    }
    // ymlDump('stats', stats)

    // stats[dateMax]
    if (dateMax !== db?.latestDate2?.[currency]) { // 如果有更新才發送
      _.set(db, `latestDate2.${currency}`, dateMax)
      const stat2 = stats[dateMax]
      await telegram.sendMessage({
        parse_mode: 'MarkdownV2',
        text: `\\# ${currency} 放貸收益報告
\`
日期: ${dateMax.replaceAll('-', '\\-')}
利息: ${floatFormatDecimal(stat2.interest, 8)} ${currency}
  1日年化: ${floatFormatDecimal(stat2.apr1, 2)}%
  7日年化: ${floatFormatDecimal(stat2.apr7, 2)}%
 30日年化: ${floatFormatDecimal(stat2.apr30, 2)}%
365日年化: ${floatFormatDecimal(stat2.apr365, 2)}%
\``,
      }).catch(err => loggers.error(inspect(err)))
    }

    await writeFile(
      new URL(`${currency}.json`, outdir),
      JSON.stringify(_.values(stats), null, 2),
    )
    await writeFile(
      new URL(`${currency}.csv`, outdir),
      Papa.unparse(_.values(stats), { headers: true }),
    )
  }

  // db.json
  await writeFile(
    new URL(`db.json`, outdir),
    JSON.stringify(db, null, 2),
  )
}

async function writeFile (filepath: URL, data: string): Promise<void> {
  try {
    await fsPromises.mkdir(new URL('.', filepath), { recursive: true })
    await fsPromises.writeFile(filepath, data)
  } catch (err) {
    _.set(err, 'data.writeFile', { filepath, data })
  }
}

const ZodAnyToUndefined = z.any().transform(() => undefined)

const ZodDb = z.object({
  schema: z.number().int().positive().default(2),
  latestDate2: z.record(z.string(), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).or(ZodAnyToUndefined).optional(),
})

async function fetchDb (url: string): Promise<z.output<typeof ZodDb>> {
  try {
    const db = (await axios.get(url))?.data
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
