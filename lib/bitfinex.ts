import { getenv } from '@/lib/dotenv'

import { z } from '@/lib/zod'
import type { JsonValue } from '@taichunmin/bitfinex'
import { RESTv2 } from 'bitfinex-api-node'
import JSON5 from 'json5'
import _ from 'lodash'

RESTv2.prototype._apiError = function (resp: any, rawBody: string) {
  try {
    const [, code, message] = JSON5.parse(rawBody)
    return _.merge(new Error(`(${code}) ${message}`), { code, ..._.pick(resp, ['status', 'statusText']) })
  } catch (err) {
    return _.merge(new Error(rawBody), _.pick(resp, ['status', 'statusText']))
  }
}

export const rest = new RESTv2(_.omitBy({
  apiKey: getenv('BITFINEX_API_KEY'),
  apiSecret: getenv('BITFINEX_API_SECRET'),
  transform: true,
  affCode: getenv('BITFINEX_AFF_CODE'),
}, _.isNil))

export async function status (): Promise<boolean> {
  try {
    const resp1 = await rest.status()
    return resp1[0] === 1
  } catch (err) {
    return false
  }
}

export async function keyPermissions (): Promise<Record<string, { read: boolean, write: boolean }>> {
  const perms = await rest.keyPermissions()
  return _.chain(perms)
    .map(perm => [perm.key, _.pick(perm, ['read', 'write'])])
    .fromPairs()
    .value()
}

export const ZodBitfinexWallet = z.object({
  type: z.string(),
  currency: z.string(),
  balance: z.number(),
  unsettledInterest: z.number(),
  balanceAvailable: z.number(),
  description: z.string().nullable(),
  meta: z.any().nullable(),
  emptyFill: z.any().nullable(),
})
export type BitfinexWallet = z.output<typeof ZodBitfinexWallet>

export async function wallets (): Promise<Map<string, BitfinexWallet>> {
  const wallets = await rest.wallets()
  const pairs = _.map(wallets, w => [`${w.type}:${w.currency}`, w]) as Array<[string, BitfinexWallet]>
  return new Map(pairs)
}

export const ZodBitfinexFundingInfo = z.object({
  symbol: z.string(),
  yieldLoan: z.number(),
  yieldLend: z.number(),
  durationLoan: z.number(),
  durationLend: z.number(),
})
export type BitfinexFundingInfo = z.output<typeof ZodBitfinexFundingInfo>

export async function fundingInfo (symbol: string): Promise<BitfinexFundingInfo> {
  const resp1 = await rest.fundingInfo({ key: symbol })
  const [yieldLoan, yieldLend, durationLoan, durationLend] = resp1[2]
  return { symbol, yieldLoan, yieldLend, durationLoan, durationLend }
}

export const ZodBitfinexCancelAllFundingOffersResp = z.object({
  status: z.string(),
  text: z.string(),
})
export type BitfinexCancelAllFundingOffersResp = z.output<typeof ZodBitfinexCancelAllFundingOffersResp>

export async function cancelAllFundingOffers (currency: string): Promise<BitfinexCancelAllFundingOffersResp> {
  const resp1 = await rest.cancelAllFundingOffers({ currency })
  if (resp1.status !== 'SUCCESS') throw _.merge(new Error(`Cancel ${resp1.status}: ${resp1.text}`), { data: resp1 })
  return resp1
}

export const ZodBitfinexCandleOpts = z.object({
  timeframe: z.string(),
  symbol: z.string(),
  section: z.string(),
  sort: z.number().optional(),
  start: z.number().optional(),
  end: z.number().optional(),
  limit: z.number().optional(),
})
export type BitfinexCandleOpts = z.output<typeof ZodBitfinexCandleOpts>

export const ZodBitfinexCandle = z.object({
  mts: z.date(),
  open: z.number(),
  close: z.number(),
  high: z.number(),
  low: z.number(),
  volume: z.number(),
})
export type BitfinexCandle = z.output<typeof ZodBitfinexCandle>

export async function candles (opts: BitfinexCandleOpts): Promise<BitfinexCandle[]> {
  // resp1 = await bitfinex.candles({ timeframe: '15m', symbol: 'fUSD:p2', section: 'hist', sort: -1, limit: 500 })
  const candles = await rest.candles({
    ..._.pick(opts, ['timeframe', 'symbol', 'section']),
    query: _.pick(opts, ['sort', 'start', 'end', 'limit']),
  })
  return _.map(candles, candle => ({
    mts: new Date(candle.mts),
    ..._.pick(candle, ['open', 'close', 'high', 'low', 'volume']),
  }))
}

const ZodSubmitAutoFundingOpts = z.discriminatedUnion('status', [
  z.object({
    status: z.literal(0),
    currency: z.string(),
  }),
  z.object({
    status: z.literal(1),
    currency: z.string(),
    amount: z.number(),
    rate: z.number(),
    period: z.number().int().positive(),
  }),
])
export type SubmitAutoFundingOpts = z.output<typeof ZodSubmitAutoFundingOpts>

export async function submitAutoFunding (opts: SubmitAutoFundingOpts): Promise<JsonValue> {
  // resp1 = await bitfinex.submitAutoFunding({ status: 1, currency: 'USD', amount: 0, rate: 0.04, period: 2 })
  opts = ZodSubmitAutoFundingOpts.parse(opts)
  return await rest.submitAutoFunding(opts)
}

export const ZodGetAutoFundingOpts = z.object({
  currency: z.string(),
})
export type GetAutoFundingOpts = z.output<typeof ZodGetAutoFundingOpts>
export const ZodGetAutoFundingResp = z.object({
  currency: z.string(),
  period: z.number().int().positive(),
  rate: z.number(),
  amount: z.number(),
})
export type GetAutoFundingResp = z.output<typeof ZodGetAutoFundingResp>

export async function getAutoFunding ({ currency }: GetAutoFundingOpts): Promise<GetAutoFundingResp | null> {
  // resp1 = await bitfinex.getAutoFunding({ currency: 'USD' })
  const transformer = (data: JsonValue): any => {
    if (!_.isArray(data)) return data
    const [currency, period, rate, amount] = data
    return { currency, period, rate, amount }
  }
  return await rest._makeAuthRequest('/auth/r/funding/auto/status', { currency }, null, transformer)
}

export const ZodBitfinexGetFundingStatsOpts = z.object({
  symbol: z.string(),
  start: z.number().optional(),
  end: z.number().optional(),
  limit: z.number().optional(),
})
export type BitfinexGetFundingStatsOpts = z.output<typeof ZodBitfinexGetFundingStatsOpts>

export const ZodBitfinexFundingStats = z.object({
  mts: z.date(),
  frr: z.number(),
  avgPeriod: z.number(),
  fundingAmount: z.number(),
  fundingAmountUsed: z.number(),
  fundingBelowThreshold: z.number(),
})
export type BitfinexFundingStats = z.output<typeof ZodBitfinexFundingStats>

export async function getFundingStats ({ symbol, start, end, limit }: BitfinexGetFundingStatsOpts): Promise<BitfinexFundingStats[]> {
  // resp1 = await bitfinex.getFundingStats({ symbol: 'fUSD' })
  const transformer = (data: JsonValue): any => {
    if (!_.isArray(data)) return data
    return _.map(data, (row: number[]) => ({
      mts: new Date(row[0]),
      frr: row[3] * 365, // To get the daily rate, use: rate x 365.
      avgPeriod: row[4],
      fundingAmount: row[7],
      fundingAmountUsed: row[8],
      fundingBelowThreshold: row[11],
    }))
  }
  const searchParams = new URLSearchParams(_.pickBy({ start, end, limit }) as Record<string, any>)
  return await rest._makePublicRequest(`/funding/stats/${symbol}/hist?${searchParams.toString()}`, null, transformer)
}
