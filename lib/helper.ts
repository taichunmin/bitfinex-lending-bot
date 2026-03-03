import { dayjs } from '@/lib/dayjs'
import type { JsonValue } from '@/lib/zod'
import JSON5 from 'json5'
import _ from 'lodash'

export function json5parseOrDefault<TVAL extends JsonValue = JsonValue> (json5: unknown): TVAL | undefined
export function json5parseOrDefault<TVAL extends JsonValue = JsonValue, TDEF extends JsonValue = TVAL> (json5: unknown, defaultVal: TDEF): TVAL | TDEF

export function json5parseOrDefault (json5: unknown, defaultVal: unknown = undefined): unknown {
  try {
    return typeof json5 === 'string' ? JSON5.parse(json5) : defaultVal
  } catch (err) {
    return defaultVal
  }
}

export function floatFormatDecimal (num: number, precision = 2): string {
  const formater = new Intl.NumberFormat('en-US', {
    maximumFractionDigits: precision,
    minimumFractionDigits: precision,
    style: 'decimal',
  })
  return formater.format(num)
}

export function floatFormatPercent (rate: number, precision = 2): string {
  const formater = new Intl.NumberFormat('en-US', {
    maximumFractionDigits: precision,
    minimumFractionDigits: precision,
    style: 'percent',
  })
  return formater.format(rate)
}

export function rateStringify (rate: number): string {
  return `${floatFormatPercent(rate, 6)} (APR: ${floatFormatPercent(rate * 365)})`
}

export function dateStringify (date?: string | number | Date | dayjs.Dayjs | null): string {
  return dayjs(date).format('YYYY-MM-DD HH:mm:ssZ')
}

export function floatIsEqual (float1: number, float2: number): boolean {
  return Math.abs(float1 - float2) < Number.EPSILON
}

export const numFloor8 = (num: number) => _.floor(num, 8)

export function progressPercent (cur: number, max: number, precision = 2): string {
  if (cur < 0 || max <= 0) return '?%'
  return floatFormatPercent(_.clamp(cur / max, 0, 1), precision)
}
