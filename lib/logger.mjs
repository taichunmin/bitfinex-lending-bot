import _ from 'lodash'
import { isDev } from './dotenv.mjs'
import { URL } from 'url'
import debug from 'debug'
import jsyaml from 'js-yaml'
import path from 'path'

export const __dirname = new URL('.', import.meta.url).pathname
export const __filename = new URL(import.meta.url).pathname

const ERROR_KEYS = [
  'address',
  'args',
  'code',
  'data',
  'dest',
  'errno',
  'extensions',
  'info',
  'locations',
  'message',
  'name',
  'path',
  'port',
  'positions',
  'reason',
  'response.data',
  'response.headers',
  'response.status',
  'source',
  'stack',
  'status',
  'statusCode',
  'statusMessage',
  'syscall',
]

const rootdir = path.resolve(__dirname, '..')
export function errToJson (err) {
  return {
    ..._.pick(err, ERROR_KEYS),
    ...(_.isNil(err.originalError) ? {} : { originalError: errToJson(err.originalError) }),
    stack: err?.stack?.replaceAll?.(rootdir, '.'),
  }
}

export function stringifyClone (obj) {
  const preventCircular = new Set()
  return _.cloneDeepWith(obj, val1 => {
    if (_.isObject(val1) && !_.isEmpty(val1)) {
      if (preventCircular.has(val1)) return '[Circular]'
      preventCircular.add(val1)
    }
    if (Buffer.isBuffer(val1)) return { type: 'Buffer', hex: val1.toString('hex') }
    if (typeof val1 === 'bigint') return val1.toString()
    if (val1 instanceof Error) return errToJson(val1)
    if (val1 instanceof Map) return _.fromPairs([...val1.entries()])
    if (val1 instanceof Set) return [...val1.values()]
  })
}

export function stringifyReplacer (key, val) {
  if (key.length > 1 && key[0] === '_') return undefined
  const censored = this?._censored ?? []
  for (const key1 of censored) {
    if (!_.hasIn(this, key1)) continue
    _.set(this, key1, '[Censored]')
  }
  delete this?._censored
  return this[key]
}

export function jsonStringify (obj) {
  return JSON.stringify(stringifyClone(obj), stringifyReplacer)
}

export function ymlStringify (obj) {
  try {
    return jsyaml.dump(stringifyClone(obj), {
      condenseFlow: true,
      lineWidth: -1,
      replacer: stringifyReplacer,
    }).slice(0, -1)
  } catch (err) {
    throw _.set(new Error(err.message), 'originalError', err)
  }
}

export function createLogger (logType, logName) {
  const logger = isDev ? debug(logName) : (console[logType] ?? console.log)
  return msg => { logger(_.isObject(msg) ? ymlStringify(msg) : msg) }
}

export function createLoggers (logName) {
  return _.chain(['debug', 'error', 'info', 'log', 'warn'])
    .map(logType => [logType, createLogger(logType, `app:${logType}:${logName}`)])
    .fromPairs()
    .value()
}

export function createLoggersByFilename (filename) {
  const logName = path.relative(rootdir, filename).replace(/\.[a-zA-Z0-9]+$/, '').replace(/\\/g, '/')
  return createLoggers(logName)
}

export function createLoggersByUrl (url) {
  return createLoggersByFilename(new URL(url).pathname)
}
