import dotenv from 'dotenv'
import { json5parseOrDefault } from './helper.mjs'

dotenv.config()

export function getenv (key, defaultVal) {
  return process.env?.[key] ?? defaultVal
}

export function getenvJson5 (key, defaultVal) {
  return json5parseOrDefault(getenv(key), defaultVal)
}

export const isDev = getenv('NODE_ENV', 'prod') === 'dev'

export const isProd = getenv('NODE_ENV', 'prod') === 'prod'
