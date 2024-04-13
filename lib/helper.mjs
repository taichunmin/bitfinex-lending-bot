import _ from 'lodash'
import { dayjs } from './dayjs.mjs'
import JSON5 from 'json5'

export function json5parseOrDefault (json5, defaultVal) {
  try {
    return _.isString(json5) ? JSON5.parse(json5) : defaultVal
  } catch (err) {
    return defaultVal
  }
}

export function floatFormatPercent (rate, precision = 2) {
  const formater = new Intl.NumberFormat('en-US', {
    maximumFractionDigits: precision,
    minimumFractionDigits: precision,
    style: 'percent',
  })
  return formater.format(rate)
}

export function rateStringify (rate) {
  return `${floatFormatPercent(rate, 6)} (APR: ${floatFormatPercent(rate * 365)})`
}

export function dateStringify (date) {
  return dayjs(date).format('YYYY-MM-DD HH:mm:ssZ')
}

export function floatIsEqual (float1, float2) {
  return Math.abs(float1 - float2) < Number.EPSILON
}
