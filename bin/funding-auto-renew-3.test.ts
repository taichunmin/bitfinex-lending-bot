import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as BitfinexModule from '@taichunmin/bitfinex'

import candlesFixture from './__fixtures__/funding-auto-renew-3.candles.json' with { type: 'json' }

// ---- 外部相依一律 mock，測試不碰真實 API ----

vi.mock('@taichunmin/bitfinex', async (importOriginal) => {
  const actual = await importOriginal<typeof BitfinexModule>()
  class MockBitfinex {}
  const statics = ['v2PlatformStatus', 'v2FundingStatsHist', 'v2CandlesHist']
  const methods = [
    'v2AuthReadSettings', 'v2AuthReadWallets', 'v2AuthReadFundingAutoStatus',
    'v2AuthWriteFundingAuto', 'v2AuthWriteFundingOfferCancelAll',
    'v2AuthReadFundingCredits', 'v2AuthReadFundingOffers', 'v2AuthWriteSettingsSet',
  ]
  for (const s of statics) (MockBitfinex as any)[s] = vi.fn()
  for (const m of methods) (MockBitfinex.prototype as any)[m] = vi.fn()
  return { ...actual, Bitfinex: MockBitfinex }
})

vi.mock('@/lib/telegram')

vi.mock('node:timers/promises', () => ({
  scheduler: { wait: vi.fn().mockResolvedValue(undefined) },
}))

// vi.mock 會被提升到 import 之前，所以這裡 import SUT 時相依已是 mock
const { ZodConfig, ZodDb, calcTargetRate, main, rateToPeriod } = await import('./funding-auto-renew-3.ts')
const { Bitfinex, PlatformStatus } = await import('@taichunmin/bitfinex')

const B = Bitfinex as any
const proto = (Bitfinex as any).prototype

const WIDE = { rank: 0.5, rateMin: 0.00001, rateMax: 0.01 }

// ---------------------------------------------------------------------------
// calcTargetRate — 純邏輯
// ---------------------------------------------------------------------------

describe('calcTargetRate', () => {
  // 一根「利率區間 0.0001 ~ 0.0003、均勻分布」的 K 線
  const spread = { open: 0.0001, close: 0.0003, high: 0.0003, low: 0.0001, volume: 1000 }

  it('沒有任何有成交量的 K 線時回傳 null', () => {
    expect(calcTargetRate([], WIDE)).toBeNull()
    expect(calcTargetRate([{ open: 0.0002, close: 0.0002, high: 0.0002, low: 0.0002, volume: 0 }], WIDE)).toBeNull()
  })

  it('單一點狀 K 線：不論 rank 都回傳該利率', () => {
    const point = { open: 0.00015, close: 0.00015, high: 0.00015, low: 0.00015, volume: 100 }
    for (const rank of [0, 0.25, 0.5, 0.75, 1]) {
      expect(calcTargetRate([point], { ...WIDE, rank })).toBeCloseTo(0.00015, 8)
    }
  })

  it('均勻區間 K 線：rank 對應到區間內線性位置', () => {
    expect(calcTargetRate([spread], { ...WIDE, rank: 0 })!).toBeCloseTo(0.0001, 6)
    expect(calcTargetRate([spread], { ...WIDE, rank: 0.25 })!).toBeCloseTo(0.00015, 5)
    expect(calcTargetRate([spread], { ...WIDE, rank: 0.5 })!).toBeCloseTo(0.0002, 5)
    expect(calcTargetRate([spread], { ...WIDE, rank: 1 })!).toBeCloseTo(0.0003, 6)
  })

  it('結果被 rateMin / rateMax 夾住', () => {
    expect(calcTargetRate([spread], { rank: 1, rateMin: 0.00001, rateMax: 0.0002 })).toBeCloseTo(0.0002, 8)
    expect(calcTargetRate([spread], { rank: 0, rateMin: 0.00015, rateMax: 0.01 })).toBeCloseTo(0.00015, 8)
  })

  it('rank 越高，利率越高（單調不遞減）', () => {
    const ranks = [0.1, 0.3, 0.5, 0.7, 0.9]
    const rates = ranks.map(rank => calcTargetRate(candlesFixture as any, { ...WIDE, rank })!)
    for (let i = 1; i < rates.length; i++) expect(rates[i]).toBeGreaterThanOrEqual(rates[i - 1])
    for (const r of rates) {
      expect(r).toBeGreaterThanOrEqual(WIDE.rateMin)
      expect(r).toBeLessThanOrEqual(WIDE.rateMax)
    }
  })

  it('對真實 K 線 fixture 的輸出（regression anchor）', () => {
    const snap = Object.fromEntries(
      [0.1, 0.5, 0.9].map(rank => [rank, calcTargetRate(candlesFixture as any, { ...WIDE, rank })]),
    )
    expect(snap).toMatchSnapshot()
  })
})

// ---------------------------------------------------------------------------
// rateToPeriod — 純邏輯（行為已與作者確認，全部視為正確）
// ---------------------------------------------------------------------------

describe('rateToPeriod', () => {
  const map = { 3: 0.0002, 30: 0.0008 } as any
  const map3 = { 3: 0.0002, 7: 0.0004, 21: 0.0008 } as any

  it('period 對照表為空 → 恆為 2', () => {
    expect(rateToPeriod({} as any, 0.00001)).toBe(2)
    expect(rateToPeriod({} as any, 0.0005)).toBe(2)
    expect(rateToPeriod({} as any, 1)).toBe(2)
  })

  it('利率低於所有門檻 → 2（刻意，不是最小的 key）', () => {
    expect(rateToPeriod(map, 0.00001)).toBe(2)
    expect(rateToPeriod({ 10: 0.0005, 20: 0.0009 } as any, 0.0001)).toBe(2)
  })

  it('利率高於所有門檻 → 表中最大 key（刻意不延伸到 120）', () => {
    expect(rateToPeriod(map, 0.01)).toBe(30)
  })

  it('利率高於所有門檻、但最大 key 超過 120 → clamp 到 120', () => {
    expect(rateToPeriod({ 2: 0.0001, 150: 0.0009 } as any, 0.01)).toBe(120)
  })

  it('精確命中某個 key → 該 key', () => {
    expect(rateToPeriod(map, 0.0002)).toBe(3)
    expect(rateToPeriod(map, 0.0008)).toBe(30)
    expect(rateToPeriod(map3, 0.0004)).toBe(7)
  })

  it('落在兩個 key 之間 → 線性內插 + Math.trunc（含浮點截尾）', () => {
    // 數學上 = 7 + 14 * 0.5 = 14，但浮點誤差讓內插值略小於 14，Math.trunc 後為 13
    expect(rateToPeriod(map3, 0.0006)).toBe(13)
    // trunc(3 + 27 * 0.5) = trunc(16.5) = 16
    expect(rateToPeriod(map, 0.0005)).toBe(16)
  })

  it('結果一律 clamp 在 [2, 120]', () => {
    expect(rateToPeriod(map, -1)).toBeGreaterThanOrEqual(2)
    expect(rateToPeriod(map, 999)).toBeLessThanOrEqual(120)
  })
})

// ---------------------------------------------------------------------------
// ZodConfig / ZodDb — 設定解析
// ---------------------------------------------------------------------------

describe('ZodConfig', () => {
  it('缺省欄位套用預設值', () => {
    const cfg = ZodConfig.parse({ USD: {} })
    expect(cfg.USD).toMatchObject({ amount: 0, rank: 0.5, rateMax: 0.01, rateMin: 0.0002, period: {} })
  })

  it('字串數值會被 coerce', () => {
    const cfg = ZodConfig.parse({ USD: { amount: '123.5', rank: '0.8' } })
    expect(cfg.USD.amount).toBe(123.5)
    expect(cfg.USD.rank).toBe(0.8)
  })

  it('rank 超出 0~1 會拋錯', () => {
    expect(() => ZodConfig.parse({ USD: { rank: 1.5 } })).toThrow()
    expect(() => ZodConfig.parse({ USD: { rank: -0.1 } })).toThrow()
  })

  it('rateMin / rateMax 低於 RATE_MIN(0.0001) 會拋錯', () => {
    expect(() => ZodConfig.parse({ USD: { rateMin: 0.00005 } })).toThrow()
    expect(() => ZodConfig.parse({ USD: { rateMax: 0 } })).toThrow()
  })

  it('空輸入 → 空物件', () => {
    expect(ZodConfig.parse(undefined)).toEqual({})
  })
})

describe('ZodDb', () => {
  it('餵入壞掉的持久化狀態不會 crash，退回 { schema: 1 }', () => {
    expect(ZodDb.parse(undefined)).toEqual({ schema: 1 })
    expect(ZodDb.parse('not an object')).toEqual({ schema: 1 })
    expect(ZodDb.parse({ schema: 999 })).toEqual({ schema: 1 })
    expect(ZodDb.parse({ schema: 1, notified: { USD: { balance: 'x' } } })).toMatchObject({ schema: 1 })
  })
})

// ---------------------------------------------------------------------------
// main() — orchestration 關鍵情境
// ---------------------------------------------------------------------------

const CONFIG_YAML = `
USD:
  amount: 100
  rank: 0.5
  rateMax: 0.01
  rateMin: 0.0001
  period:
    2: 0.0002
    30: 0.0008
`

const MAIN_OPTS = { rank: 0.5, rateMin: 0.0001, rateMax: 0.01 }
const expectedRate = calcTargetRate(candlesFixture as any, MAIN_OPTS)!
const expectedPeriod = rateToPeriod({ 2: 0.0002, 30: 0.0008 } as any, expectedRate)

function setHappyPath (): void {
  vi.stubEnv('INPUT_AUTO_RENEW_3', CONFIG_YAML)
  B.v2PlatformStatus.mockResolvedValue({ status: PlatformStatus.OPERATIVE })
  B.v2FundingStatsHist.mockResolvedValue([{ mts: new Date('2026-08-29T00:00:00Z'), frr: 0.0001 }])
  B.v2CandlesHist.mockResolvedValue(candlesFixture)
  proto.v2AuthReadSettings.mockResolvedValue({})
  proto.v2AuthReadWallets.mockResolvedValue([])
  proto.v2AuthReadFundingAutoStatus.mockResolvedValue(null)
  proto.v2AuthWriteFundingAuto.mockResolvedValue(undefined)
  proto.v2AuthWriteFundingOfferCancelAll.mockResolvedValue(undefined)
  proto.v2AuthReadFundingCredits.mockResolvedValue([])
  proto.v2AuthReadFundingOffers.mockResolvedValue([])
  proto.v2AuthWriteSettingsSet.mockResolvedValue(undefined)
}

describe('main()', () => {
  beforeEach(setHappyPath)

  it('情境 1：平台維護中 → 提早 return，完全不讀寫帳號資料', async () => {
    B.v2PlatformStatus.mockResolvedValue({ status: PlatformStatus.MAINTENANCE })

    await main()

    expect(proto.v2AuthReadWallets).not.toHaveBeenCalled()
    expect(proto.v2AuthWriteFundingAuto).not.toHaveBeenCalled()
    expect(proto.v2AuthWriteSettingsSet).not.toHaveBeenCalled()
  })

  it('情境 2：沒有 K 線 → 跳過該貨幣、不動 autoRenew，但仍持久化 DB', async () => {
    B.v2CandlesHist.mockResolvedValue([])

    await main()

    expect(proto.v2AuthWriteFundingAuto).not.toHaveBeenCalled()
    expect(proto.v2AuthWriteFundingOfferCancelAll).not.toHaveBeenCalled()
    expect(proto.v2AuthWriteSettingsSet).toHaveBeenCalledTimes(1)
  })

  it('情境 3：目前設定與新計算相符 → 跳過、不下任何寫入', async () => {
    proto.v2AuthReadFundingAutoStatus.mockResolvedValue({
      currency: 'USD',
      amount: 100,
      period: expectedPeriod,
      rate: expectedRate,
    })

    await main()

    expect(proto.v2AuthWriteFundingAuto).not.toHaveBeenCalled()
    expect(proto.v2AuthWriteFundingOfferCancelAll).not.toHaveBeenCalled()
  })

  it('情境 4：設定有變 → 依序 關閉→取消掛單→重新開啟，且帶入正確 rate/period', async () => {
    proto.v2AuthReadFundingAutoStatus.mockResolvedValue({
      currency: 'USD',
      amount: 100,
      period: 2,
      rate: 0.00001, // 與新計算不同
    })

    await main()

    const auto = proto.v2AuthWriteFundingAuto
    const cancel = proto.v2AuthWriteFundingOfferCancelAll

    expect(auto).toHaveBeenCalledTimes(2)
    expect(cancel).toHaveBeenCalledTimes(1)

    // 參數正確
    expect(auto.mock.calls[0][0]).toEqual({ currency: 'USD', status: 0 })
    expect(cancel.mock.calls[0][0]).toEqual({ currency: 'USD' })
    expect(auto.mock.calls[1][0]).toEqual({
      amount: 100,
      currency: 'USD',
      period: expectedPeriod,
      rate: expectedRate * 100,
      status: 1,
    })

    // 呼叫順序：關閉 → 取消掛單 → 重新開啟
    expect(auto.mock.invocationCallOrder[0]).toBeLessThan(cancel.mock.invocationCallOrder[0])
    expect(cancel.mock.invocationCallOrder[0]).toBeLessThan(auto.mock.invocationCallOrder[1])
  })
})
