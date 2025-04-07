/*
yarn tsx ./bin/funding-auto-renew-2.ts

程式決定借出利率的邏輯：
1. 取得過去 1441 分鐘的 K 線圖
2. 把成交量加總 totalVolume
3. 利用二分搜尋法，找出最接近 totalVolume * rank 的利率
*/

// import first before other imports
import { getenv } from '../lib/dotenv.mjs'

import { Bitfinex, BitfinexSort, PlatformStatus } from '@taichunmin/bitfinex'
import JSON5 from 'json5'
import _ from 'lodash'
import { scheduler } from 'node:timers/promises'
import * as url from 'node:url'
import { z } from 'zod'
import { dayjs } from '../lib/dayjs.mjs'
import { dateStringify, floatFormatDecimal, floatIsEqual, rateStringify } from '../lib/helper.mjs'
import { createLoggersByUrl } from '../lib/logger.mjs'
import * as telegram from '../lib/telegram.mjs'

const loggers = createLoggersByUrl(import.meta.url)
const filename = new URL(import.meta.url).pathname.replace(/^.*?([^/\\]+)\.[^.]+$/, '$1')
const RATE_MIN = 0.0001 // APR 3.65%
const bitfinex = new Bitfinex({
  apiKey: getenv('BITFINEX_API_KEY'),
  apiSecret: getenv('BITFINEX_API_SECRET'),
  affCode: getenv('BITFINEX_AFF_CODE'),
})

function ymlDump (key: string, val: any): void {
  loggers.log(_.set({}, key, val))
}

;(BigInt as any).prototype.toJSON ??= function () { // hack to support JSON.stringify
  return this.toString()
}

function bigintAbs (a: bigint): bigint {
  return a < 0n ? -a : a
}

const ZodConfig = z.object({
  amount: z.coerce.number().min(0).default(0),
  currency: z.coerce.string().default('USD'),
  period: z.record(z.coerce.number().int().min(2).max(120), z.number().positive()).default({}),
  rank: z.coerce.number().min(0).max(1).default(0.5),
  rateMax: z.coerce.number().min(RATE_MIN).default(0.01),
  rateMin: z.coerce.number().min(RATE_MIN).default(0.0002),
})

export async function main (): Promise<void> {
  const cfg = ZodConfig.parse({
    amount: getenv('INPUT_AMOUNT'),
    currency: getenv('INPUT_CURRENCY'),
    period: JSON5.parse(getenv('INPUT_PERIOD')),
    rank: getenv('INPUT_RANK'),
    rateMax: getenv('INPUT_RATE_MAX'),
    rateMin: getenv('INPUT_RATE_MIN'),
  })
  ymlDump('input', {
    ...cfg,
    rateMin: rateStringify(cfg.rateMin),
    rateMax: rateStringify(cfg.rateMax),
  })
  if ((await Bitfinex.v2PlatformStatus()).status === PlatformStatus.MAINTENANCE) {
    loggers.error('Bitfinex API is in maintenance mode')
    return
  }

  const fundingStats = (await Bitfinex.v2FundingStatsHist({ currency: cfg.currency, limit: 1 }))?.[0]
  ymlDump('fundingStats', {
    currency: cfg.currency,
    date: dateStringify(fundingStats.mts),
    frr: rateStringify(fundingStats.frr),
  })

  // get status of auto funding
  const autoFunding = await bitfinex.v2AuthReadFundingAutoStatus({ currency: cfg.currency })
  if (_.isNil(autoFunding)) loggers.log({ autoRenew: { status: false } })
  else {
    ymlDump('autoRenew', {
      currency: cfg.currency,
      rate: rateStringify(autoFunding.rate),
      period: autoFunding.period,
      amount: autoFunding.amount,
    })
  }

  // get candles
  const candles = await Bitfinex.v2CandlesHist({
    aggregation: 30,
    currency: cfg.currency,
    limit: 1441, // 1 day + 1 min
    periodEnd: 30,
    periodStart: 2,
    sort: BitfinexSort.DESC,
    timeframe: '1m',
  })

  // ranges
  const yesterday = dayjs().add(-1, 'day').add(-1, 'second').toDate()
  const ranges = _.chain(candles)
    .filter(candle => candle.mts >= yesterday && candle.volume > 0)
    .map(candle => {
      const [open, close, high, low, volume] = _.chain(candle)
        .pick(['open', 'close', 'high', 'low', 'volume'])
        .map(num => BigInt(_.round(num * 1e8)))
        .value()
      return [
        _.min([open, close, high, low]), // min * 1e8
        _.max([open, close, high, low]), // high * 1e8
        volume, // volume
      ] as [bigint, bigint, bigint]
    })
    .sortBy([0, 1, 2])
    .value()
  // sum duplicate ranges
  for (let i = 1; i < ranges.length; i++) {
    const [low, high, volume] = ranges[i]
    if (volume > 0n) {
      if (low !== ranges[i - 1][0] || high !== ranges[i - 1][1]) continue
      ranges[i - 1][2] += volume
    }
    ranges.splice(i, 1)
    i--
  }
  // console.log(`ranges.length = ${ranges.length}, ranges: ${JSON.stringify(_.take(ranges, 10))}`)
  if (ranges.length === 0) {
    loggers.log('Setting of auto-renew no change because no candles.')
    return
  }

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
    rank: BigInt(_.round(cfg.rank * 1e8)),
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
  const targetRate = _.clamp(Number(ctxBs.targetRate) / 1e8, cfg.rateMin, cfg.rateMax)
  const target = {
    rate: targetRate,
    period: rateToPeriod(cfg.period, targetRate),
  }
  ymlDump('target', { ...target, rate: rateStringify(target.rate) })

  if (_.isMatchWith(autoFunding ?? {}, target, floatIsEqual)) {
    loggers.log('Setting of auto-renew no change.')
    return
  }

  if (autoFunding) await bitfinex.v2AuthWriteFundingAuto({ ..._.pick(cfg, ['currency']), status: 0 })
  await bitfinex.v2AuthWriteFundingOfferCancelAll(_.pick(cfg, ['currency']))
  await bitfinex.v2AuthWriteFundingAuto({
    ..._.pick(cfg, ['currency', 'amount']),
    period: target.period,
    rate: target.rate * 100, // percentage of rate
    status: 1,
  }).catch(err => { throw _.merge(err, { data: { target } }) })

  // 取得掛單並計算掛單中的總金額
  await scheduler.wait(1000) // 等待 1 秒鐘，讓掛單生效
  const orders = await bitfinex.v2AuthReadFundingOffers({ currency: cfg.currency })
  const orderAmount = floatFormatDecimal(_.sumBy(orders, 'amount') ?? 0, 8)
  loggers.log({ orders, orderAmount })

  await telegram.sendMessage({
    text: `${filename}:\n以 ${rateStringify(target.rate)} 利率自動借出 ${orderAmount} ${cfg.currency}，最多 ${target.period} 天`,
  }).catch(err => loggers.error(err))
}

export function rateToPeriod (periodMap: z.output<typeof ZodConfig>['period'], rateTarget) {
  const sortedPeriods = _.chain(periodMap)
    .map((v, k) => ({ peroid: _.toSafeInteger(k), rate: _.toFinite(v) }))
    .orderBy(['peroid'], ['desc'])
    .value()
  const periodTarget = _.find(sortedPeriods, ({ peroid, rate }) => rateTarget >= rate)?.peroid ?? 2
  return _.clamp(periodTarget, 2, 120)
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
