// import first before other imports
import { getenv } from '../lib/dotenv.mjs'

import _ from 'lodash'
import { createLoggersByUrl } from '../lib/logger.mjs'
import { dateStringify, floatIsEqual, rateStringify } from '../lib/helper.mjs'
import { z } from 'zod'
import * as bitfinex from '../lib/bitfinex.mjs'
import * as telegram from '../lib/telegram.mjs'
import * as url from 'node:url'
import JSON5 from 'json5'

const loggers = createLoggersByUrl(import.meta.url)
const RATE_MIN = 0.0001 // APR 3.65%

const ZodJson5CastObj = zodType => { // parse json5 string to object
  return z.preprocess(val => {
    try {
      return JSON5.parse(val)
    } catch (err) {
      return val
    }
  }, zodType)
}

const ZodConfig = z.object({
  amount: z.coerce.number().min(0).default(0),
  currency: z.coerce.string().default('USD'),
  rateMax: z.coerce.number().min(RATE_MIN).default(0.01),
  rateMin: z.coerce.number().min(RATE_MIN).default(0.0002),
  period: ZodJson5CastObj(z.record(z.coerce.number().int().min(2).max(120), z.number().positive()).default({})),
})

export async function main () {
  const cfg = ZodConfig.parse({
    amount: getenv('INPUT_AMOUNT'),
    currency: getenv('INPUT_CURRENCY'),
    period: getenv('INPUT_PERIOD'),
    rateMax: getenv('INPUT_RATE_MAX'),
    rateMin: getenv('INPUT_RATE_MIN'),
  })
  loggers.log(_.set({}, 'input', {
    ...cfg,
    rateMin: rateStringify(cfg.rateMin),
    rateMax: rateStringify(cfg.rateMax),
  }))
  if (!await bitfinex.status()) {
    loggers.error('Bitfinex API is in maintenance mode')
    return
  }

  const fundingStats = _.first(await bitfinex.getFundingStats({ limit: 1, symbol: `f${cfg.currency}` }))
  loggers.log(_.set({}, 'fundingStats', {
    currency: cfg.currency,
    date: dateStringify(fundingStats.mts),
    frr: rateStringify(fundingStats.frr),
  }))

  // get status of auto funding
  const autoFunding = await bitfinex.getAutoFunding({ currency: cfg.currency })
  if (_.isNil(autoFunding)) loggers.log({ autoRenew: { status: false } })
  else {
    loggers.log(_.set({}, 'autoRenew', {
      currency: cfg.currency,
      rate: rateStringify(autoFunding.rate),
      period: autoFunding.period,
      amount: autoFunding.amount,
    }))
  }

  // get candles
  const candles = await bitfinex.candles({
    limit: 25,
    section: 'hist',
    sort: -1,
    symbol: `f${cfg.currency}:a30:p2:p30`,
    timeframe: '30m',
  })

  // 從 FRR 及最近的 N 根 K 棒的 high 中，取前 2 高到前 11 高的資料計算平均值（忽略最高）。
  const target = { amount: cfg.amount }
  target.rate = _.chain(candles).map('high').thru(rates => [...rates, fundingStats.frr]).sortBy().slice(-11, -1).sum().thru(rate => rate / 10).clamp(cfg.rateMin, cfg.rateMax).value()
  target.period = rateToPeriod(cfg.period, target.rate)
  loggers.log(_.set({}, 'target', {
    ...target,
    rate: rateStringify(target.rate),
  }))

  if (_.isMatchWith(autoFunding, target, floatIsEqual)) {
    loggers.log('Setting of auto-renew no change.')
    return
  }

  if (autoFunding) await bitfinex.submitAutoFunding({ ..._.pick(cfg, ['currency']), status: 0 })
  await bitfinex.cancelAllFundingOffers(cfg.currency)
  await bitfinex.submitAutoFunding({
    ..._.pick(cfg, ['currency', 'amount']),
    period: target.period,
    rate: target.rate * 100, // percentage of rate
    status: 1,
  }).catch(err => { throw _.merge(err, { data: { target } }) })
  await telegram.sendMessage({
    text: `funding-auto-renew-1:\n以 ${rateStringify(target.rate)} 利率自動借出 ${cfg.currency}，最多 ${target.period} 天`,
  }).catch(err => loggers.error(err))
}

export function rateToPeriod (periodMap, rateTarget) {
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
