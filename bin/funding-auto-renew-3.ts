/*
yarn tsx ./bin/funding-auto-renew-3.ts

程式決定借出利率的邏輯：
1. 取得過去一天內的每分鐘 K 線圖
2. 把成交量加總 totalVolume
3. 利用二分搜尋法，找出最接近 totalVolume * rank 的利率
*/

// import first before other imports
import { getenv } from '@/lib/dotenv'

import { dayjs } from '@/lib/dayjs'
import { dateStringify, floatFormatDecimal, floatFormatPercent, floatIsEqual, floatFloor8, progressPercent, rateStringify } from '@/lib/helper'
import { createLoggersByUrl, ymlStringify } from '@/lib/logger'
import * as telegram from '@/lib/telegram'
import { tgMdEscape } from '@/lib/telegram'
import { z } from '@/lib/zod'
import { Bitfinex, BitfinexSort, PlatformStatus } from '@taichunmin/bitfinex'
import jsyaml from 'js-yaml'
import _ from 'lodash'
import { scheduler } from 'node:timers/promises'
import * as url from 'node:url'

const loggers = createLoggersByUrl(import.meta.url)
const filename = new URL(import.meta.url).pathname.replace(/^.*?([^/\\]+)\.[^.]+$/, '$1')
const DB_KEY = `api:taichunmin_${filename}`
const RATE_MIN = 0.0001 // APR 3.65%
const bitfinex = new Bitfinex({
  apiKey: getenv('BITFINEX_API_KEY'),
  apiSecret: getenv('BITFINEX_API_SECRET'),
  affCode: getenv('BITFINEX_AFF_CODE'),
})

function ymlDump (key: string, val: any): void {
  loggers.log({ [key]: val })
}

;(BigInt as any).prototype.toJSON ??= function () { // hack to support JSON.stringify
  return this.toString()
}

function bigintAbs (a: bigint): bigint {
  return a < 0n ? -a : a
}

const ZodConfigPeriod = z.record(
  z.number().int().min(2).max(120),
  z.number().positive(),
).default({})

const ZodConfigCurrency = z.object({
  amount: z.coerce.number().min(0).default(0),
  rank: z.coerce.number().min(0).max(1).default(0.5),
  rateMax: z.coerce.number().min(RATE_MIN).default(0.01),
  rateMin: z.coerce.number().min(RATE_MIN).default(0.0002),
  period: ZodConfigPeriod,
})

const ZodConfig = z.record(z.string(), ZodConfigCurrency).default({})

const ZodDb = z.object({
  schema: z.literal(1), // 用來辨識資料結構版本，方便未來升級
  notified: z.record(
    z.string(),
    z.object({
      balance: z.number().transform(floatFloor8),
      creditIds: z.array(z.int()),
      msgId: z.int(),
    }).nullish().catch(null),
  ).nullish().catch(null),
}).catch({ schema: 1 })

class SkipError extends Error {}

export async function main (): Promise<void> {
  if ((await Bitfinex.v2PlatformStatus()).status === PlatformStatus.MAINTENANCE) {
    loggers.error('Bitfinex API is in maintenance mode')
    return
  }

  // 讀取並驗證設定
  const cfg = ZodConfig.parse(jsyaml.load(getenv('INPUT_AUTO_RENEW_3', ''), { json: true, schema: jsyaml.JSON_SCHEMA }))

  const db = ZodDb.parse((await bitfinex.v2AuthReadSettings([DB_KEY]))[DB_KEY.slice(4)])
  ymlDump('db', db)

  const wallets = _.mapKeys(await bitfinex.v2AuthReadWallets(), ({ type, currency }) => `${type}:${currency}`)
  ymlDump('wallets', wallets)

  for (const [currency, cfg1] of _.entries(cfg)) {
    const trace: Record<string, any> = { currency, cfg1 }
    try {
      ymlDump(`cfg.${currency}`, {
        currency,
        ...cfg1,
        rateMinStr: rateStringify(cfg1.rateMin),
        rateMaxStr: rateStringify(cfg1.rateMax),
      })

      // 取得該貨幣最新一筆融資統計
      const fundingStats = (await Bitfinex.v2FundingStatsHist({ currency, limit: 1 }))[0]
      ymlDump('fundingStats', {
        currency,
        date: dateStringify(fundingStats.mts),
        frrStr: rateStringify(fundingStats.frr),
      })

      // 修改 autoRenew 的參數
      try {
        // 取得該貨幣自動出借的設定
        const prevAutoRenew = await bitfinex.v2AuthReadFundingAutoStatus({ currency })
        if (_.isNil(prevAutoRenew)) ymlDump('prevAutoRenew', { status: false })
        else {
          ymlDump('prevAutoRenew', {
            ...prevAutoRenew,
            rateStr: rateStringify(prevAutoRenew.rate),
          })
        }

        // get candles
        const yesterday = dayjs().add(-1, 'day').add(-1, 'second').toDate()
        const candles = await Bitfinex.v2CandlesHist({
          aggregation: 30,
          currency,
          limit: 10000,
          periodEnd: 30,
          periodStart: 2,
          sort: BitfinexSort.DESC,
          start: yesterday,
          timeframe: '1m',
        })

        // ranges
        const ranges = _.chain(candles)
          .map(({ open, close, high, low, volume }) => _.map([
              _.min([open, close, high, low]), // min * 1e8
              _.max([open, close, high, low]), // high * 1e8
              volume, // volume * 1e8
            ], (num: number) => BigInt(_.round(num * 1e8))))
          .filter(([low, high, volume]) => volume > 0n)
          .sortBy([0, 1, 2])
          .value()
        // sum duplicate ranges
        for (let i = 1; i < ranges.length; i++) {
          const [low, high, volume] = ranges[i]
          if (low !== ranges[i - 1][0] || high !== ranges[i - 1][1]) continue
          ranges[i - 1][2] += volume
          ranges.splice(i, 1)
          i--
        }
        // console.log(`ranges.length = ${ranges.length}, ranges: ${JSON.stringify(_.take(ranges, 10))}`)
        if (ranges.length === 0) throw new SkipError('Skip to change autoRenew because no candles.')

        // for lowest rate and highest rate
        let [lowestRate, highestRate, totalVolume] = [ranges[0][0], ranges[0][1], 0n]
        for (const [low, high, volume] of ranges) {
          if (high > highestRate) highestRate = high
          if (low < lowestRate) lowestRate = low
          totalVolume += volume
        }
        // console.log(`lowestRate = ${lowestRate}, highestRate = ${highestRate}, totalVolume = ${totalVolume}`)

        // binary search target rate by rank
        const ctxBs: Record<string, any> = {
          rank: BigInt(_.round(cfg1.rank * 1e8)),
          cnt: 0n,
          start: lowestRate,
          end: highestRate,
        }
        // console.log(`ctxBs: ${JSON.stringify(ctxBs)}`)
        while (ctxBs.start <= ctxBs.end) {
          ctxBs.mid = (ctxBs.start + ctxBs.end) / 2n

          // calculate volume for mid
          ctxBs.midVol = 0n
          for (const [low, high, volume] of ranges) {
            if (ctxBs.mid < low) break // because ranges is sorted
            ctxBs.midVol += ctxBs.mid >= high ? volume : (volume * (ctxBs.mid - low + 1n) / (high - low + 1n))
          }
          ctxBs.midRank = ctxBs.midVol * BigInt(1e8) / totalVolume

          // save target rate
          const targetRankDiff = bigintAbs((ctxBs.midRank - ctxBs.rank) as any)
          if (_.isNil(ctxBs.targetRate)) {
            ctxBs.targetRate = ctxBs.mid
            ctxBs.targetRankDiff = targetRankDiff
          } else if (targetRankDiff < ctxBs.targetRankDiff) {
            ctxBs.targetRate = ctxBs.mid
            ctxBs.targetRankDiff = targetRankDiff
          }

          if (ctxBs.midRank === ctxBs.rank) break // found
          if (ctxBs.rank < ctxBs.midRank) ctxBs.end = ctxBs.mid - 1n
          else ctxBs.start = ctxBs.mid + 1n
          ctxBs.cnt++
          // console.log(`ctxBs: ${JSON.stringify(ctxBs)}`)
        }

        // target
        const targetRate = _.clamp(Number(ctxBs.targetRate) / 1e8, cfg1.rateMin, cfg1.rateMax)
        const newAutoRenew = trace.newAutoRenew = {
          amount: cfg1.amount,
          currency,
          period: rateToPeriod(cfg1.period, targetRate),
          rate: targetRate,
        }
        ymlDump('newAutoRenew', { ...newAutoRenew, rateStr: rateStringify(newAutoRenew.rate) })

        if (_.isMatch(prevAutoRenew ?? {}, newAutoRenew)) throw new SkipError('Setting of auto-renew no change.')
        else {
          if (!_.isNil(prevAutoRenew)) await bitfinex.v2AuthWriteFundingAuto({ currency, status: 0 })
          await bitfinex.v2AuthWriteFundingOfferCancelAll({ currency })
          await bitfinex.v2AuthWriteFundingAuto({
            ...newAutoRenew,
            rate: newAutoRenew.rate * 100, // percentage of rate
            status: 1,
          }).catch(err => { throw _.set(err, 'data.newAutoRenew', newAutoRenew) })
          await scheduler.wait(1000) // 等待 1 秒鐘，讓掛單生效
        }
      } catch (err) {
        if (!(err instanceof SkipError)) throw err
        loggers.log(err.message)
      }

      const wallet = wallets[`funding:${currency}`] ?? { balance: 0 }
      if (wallet.balance >= Number.EPSILON && !_.isNil(trace.newAutoRenew)) {
        const db1: Record<string, any> = db.notified?.[currency] ?? {}
        const autoRenew = _.pickBy(trace.newAutoRenew, _.isNumber)
        let reuseMsgId = _.isNumber(db1.msgId)

        // 取得錢包資料
        reuseMsgId &&= floatIsEqual(db1.balance, wallet.balance)

        // 取得出借中的融資
        const credits = _.chain(await bitfinex.v2AuthReadFundingCredits({ currency }))
          .filter(({ side }) => side === 1)
          .map(credit => _.pick(credit, ['id', 'amount', 'rate', 'period', 'mtsOpening']))
          .map(credit => ({
            ...credit,
            mtsOpening: dayjs(credit.mtsOpening).utcOffset(8).format('M/D HH:mm'),
            rate: floatFormatPercent(credit.rate, 6),
            apr: floatFormatPercent(credit.rate * 365),
          }))
          .value()
        const creditsAmountSum = _.sumBy(credits, 'amount')
        const creditIds = _.sortBy(_.map(credits, 'id'))
        reuseMsgId &&= _.isEqual(db1.creditIds, creditIds)

        // 取得掛單並計算掛單中的總金額
        const orders = await bitfinex.v2AuthReadFundingOffers({ currency })
        const ordersAmountSum = _.sumBy(orders, 'amount')

        const nowts = dayjs().utcOffset(8)
        const msgText = [
          tgMdEscape(`# ${filename}: ${currency} 狀態

投資額: ${floatFormatDecimal(wallet.balance, 3)}
已借出: ${floatFormatDecimal(creditsAmountSum, 3)} (${progressPercent(creditsAmountSum, wallet.balance)})
掛單中: ${floatFormatDecimal(ordersAmountSum, 3)} (${progressPercent(ordersAmountSum, wallet.balance)})
自動掛單設定:
    利率: ${floatFormatPercent(autoRenew.rate, 6)}
    APR: ${floatFormatPercent(autoRenew.rate * 365)}
    天數: ${autoRenew.period}`),
          `更新: ${tgMdEscape(nowts.format('M/D HH:mm'))} \\(${telegram.tgMdDate({ text: '?', date: nowts.toDate(), format: 'r' })}\\)\n`,
          '**>```',
          ymlStringify({ credits }),
          '```||',
        ].join('\n')

        if (reuseMsgId) {
          await telegram.editMessageText({
            message_id: db1.msgId,
            parse_mode: 'MarkdownV2',
            text: msgText,
          })
        } else {
          const res1 = await telegram.sendMessage({
            parse_mode: 'MarkdownV2',
            text: msgText,
          })
          _.set(db, `notified.${currency}`, {
            msgId: res1.message_id,
            balance: wallet.balance,
            creditIds,
          })
        }
      }
    } catch (err) {
      _.update(err, `data.main.${currency}`, old => old ?? trace)
      loggers.error([err])
    } finally {
      loggers.log('- - -\n')
    }
  }

  ymlDump('newDb', db)
  await bitfinex.v2AuthWriteSettingsSet({ [DB_KEY]: ZodDb.parse(db) as any })
}

export function rateToPeriod (periodMap: z.output<typeof ZodConfigPeriod>, rateTarget: number): number {
  const ctxPeriod: Record<string, number | null> = { lower: null, target: null, upper: null }
  for (const entry of _.entries(periodMap)) {
    const [period, rate] = [_.toSafeInteger(entry[0]), _.toFinite(entry[1])]
    if (rateTarget >= rate) ctxPeriod.lower = _.max([ctxPeriod.lower ?? period, period])
    if (rateTarget <= rate) ctxPeriod.upper = _.min([ctxPeriod.upper ?? period, period])
  }

  if (_.isNil(ctxPeriod.lower)) ctxPeriod.target = 2
  else if (_.isNil(ctxPeriod.upper)) ctxPeriod.target = ctxPeriod.lower
  else if (ctxPeriod.lower === ctxPeriod.upper) ctxPeriod.target = ctxPeriod.lower
  else ctxPeriod.target = Math.trunc(ctxPeriod.lower + (ctxPeriod.upper - ctxPeriod.lower) * (rateTarget - periodMap[ctxPeriod.lower]) / (periodMap[ctxPeriod.upper] - periodMap[ctxPeriod.lower]))

  return _.clamp(ctxPeriod.target, 2, 120)
}

class NotMainModuleError extends Error {}
try {
  if (!_.startsWith(import.meta.url, 'file:')) throw new NotMainModuleError()
  const modulePath = url.fileURLToPath(import.meta.url)
  if (process.argv[1] !== modulePath) throw new NotMainModuleError()
  await main()
} catch (err) {
  if (!(err instanceof NotMainModuleError)) {
    loggers.error([err])
    process.exit(1)
  }
}
