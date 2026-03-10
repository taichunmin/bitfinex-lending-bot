import { dayjs } from '@/lib/dayjs'
import type { JsonValue } from '@/lib/zod'
import jsyaml from 'js-yaml'
import JSON5 from 'json5'
import _ from 'lodash'
import { promises as fsPromises } from 'node:fs'

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

export const floatFloor8 = (num: number) => _.floor(num, 8)

export function progressPercent (cur: number, max: number, precision = 2): string {
  if (cur < 0 || max <= 0) return '?%'
  return floatFormatPercent(_.clamp(cur / max, 0, 1), precision)
}

export function toUtcDateStr (date: Date): string {
  return dayjs.utc(date).format('YYYY-MM-DD HH:mm:ss')
}

export function parseYaml (str: string): unknown {
  return jsyaml.load(str, { json: true, schema: jsyaml.JSON_SCHEMA })
}

export async function writeFile (filepath: URL, data: string): Promise<void> {
  try {
    await fsPromises.mkdir(new URL('.', filepath), { recursive: true })
    await fsPromises.writeFile(filepath, data)
  } catch (err) {
    _.set(err, 'data.writeFile', { filepath, data })
  }
}
