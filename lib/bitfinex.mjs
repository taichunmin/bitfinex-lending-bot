import _ from 'lodash'
import { getenv } from './dotenv.mjs'
import { RESTv2 } from 'bitfinex-api-node'
import JSON5 from 'json5'

RESTv2.prototype._apiError = function (resp, rawBody) {
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

export async function status () {
  const resp1 = await rest.status()
  return resp1[0] === 1
}

export async function keyPermissions () {
  const perms = await rest.keyPermissions()
  return _.chain(perms)
    .map(perm => [perm.key, _.pick(perm, ['read', 'write'])])
    .fromPairs()
    .value()
}

export async function wallets () {
  const wallets = await rest.wallets()
  const pairs = _.map(wallets, w => [`${w.type}:${w.currency}`, w])
  return new Map(pairs)
}

export async function fundingInfo (symbol) {
  const resp1 = await rest.fundingInfo({ key: symbol })
  const [yieldLoan, yieldLend, durationLoan, durationLend] = resp1[2]
  return { symbol, yieldLoan, yieldLend, durationLoan, durationLend }
}

export async function cancelAllFundingOffers (currency) {
  const resp1 = await rest.cancelAllFundingOffers({ currency })
  if (resp1.status !== 'SUCCESS') throw _.merge(new Error(`Cancel ${resp1.status}: ${resp1.text}`), { data: resp1 })
  return resp1
}

export async function candles (opts) {
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

export async function submitAutoFunding ({ status, currency, amount, rate, period }) {
  // resp1 = await bitfinex.submitAutoFunding({ status: 1, currency: 'USD', amount: 0, rate: 0.04, period: 2 })
  return await rest.submitAutoFunding({ status, currency, amount, rate, period })
}

export async function getAutoFunding ({ currency }) {
  // resp1 = await bitfinex.getAutoFunding({ currency: 'USD' })
  const transformer = data => {
    if (!_.isArray(data)) return data
    const [currency, period, rate, amount] = data
    return { currency, period, rate, amount }
  }
  return await rest._makeAuthRequest('/auth/r/funding/auto/status', { currency }, null, transformer)
}

export async function getFundingStats ({ symbol, start, end, limit }) {
  // resp1 = await bitfinex.getFundingStats({ symbol: 'fUSD' })
  const transformer = data => {
    if (!_.isArray(data)) return data
    return _.map(data, row => ({
      mts: new Date(row[0]),
      frr: row[3] * 365, // To get the daily rate, use: rate x 365.
      avgPeriod: row[4],
      fundingAmount: row[7],
      fundingAmountUsed: row[8],
      fundingBelowThreshold: row[11],
    }))
  }
  const searchParams = new URLSearchParams(_.pickBy({ start, end, limit }))
  return await rest._makePublicRequest(`/funding/stats/${symbol}/hist?${searchParams}`, null, transformer)
}
