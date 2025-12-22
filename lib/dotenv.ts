import 'dotenv/config'

import { json5parseOrDefault } from '@/lib/helper'
import type { JsonValue } from './zod'

export function getenv (key: string): string | undefined
export function getenv<T = string> (key: string, defaultVal: T): string | T

export function getenv (key: string, defaultVal?: any): any {
  return process.env[key] ?? defaultVal
}

export function getenvJson5<TVAL extends JsonValue = JsonValue> (key: string): TVAL | undefined
export function getenvJson5<TVAL extends JsonValue = JsonValue, TDEF extends JsonValue = TVAL> (key: string, defaultVal: TDEF): TVAL | TDEF

export function getenvJson5 (key: string, defaultVal?: any): any {
  return json5parseOrDefault(getenv(key), defaultVal)
}

export const isProd = getenv('NODE_ENV', 'prod') === 'prod'
export const isDev = getenv('NODE_ENV', 'prod') === 'dev'
