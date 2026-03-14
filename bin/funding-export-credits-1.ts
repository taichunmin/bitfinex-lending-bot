/*
yarn tsx ./bin/funding-export-credits-1.ts

以 CSV 格式匯出該月份的歷史借出記錄到 Google Cloud Storage。

本地手動上傳:

gcloud auth login
gcloud config set project taichunmin
gcloud storage cp -R -Z --cache-control='public, no-transform, max-age=30' ./dist/funding-export-credits-1/ gs://storage-taichunmin.taichunmin.idv.tw/bitfinex-funding-credits-1
*/

import { getenv } from '@/lib/dotenv'

// import { uploadCsv } from '@/lib/gcs'
import { toUtcDateStr, writeFile } from '@/lib/helper'
import { createLoggersByUrl } from '@/lib/logger'
import { Bitfinex, PlatformStatus } from '@taichunmin/bitfinex'
import _ from 'lodash'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { inspect } from 'node:util'
import Papa from 'papaparse'

const loggers = createLoggersByUrl(import.meta.url)
const filename = new URL(import.meta.url).pathname.replace(/^.*?([^/\\]+)\.[^.]+$/, '$1')
const outdir = new URL(`../dist/${filename}/`, import.meta.url)
const bitfinex = new Bitfinex({
  apiKey: getenv('BITFINEX_API_KEY'),
  apiSecret: getenv('BITFINEX_API_SECRET'),
  affCode: getenv('BITFINEX_AFF_CODE'),
})

export async function main (): Promise<void> {
  const trace: Record<string, any> = {}

  try {
    if ((await Bitfinex.v2PlatformStatus()).status === PlatformStatus.MAINTENANCE) {
      loggers.error('Bitfinex API is in maintenance mode')
      return
    }

    const creditsByCurr: Record<string, any[]> = {}
    let creditEnd = null
    let creditsLen = 0
    while (true) {
      try {
        const credits1 = await bitfinex.v2AuthReadFundingCreditsHist({
          ...(_.isNil(creditEnd) ? {} : { end: creditEnd }),
          limit: 500,
        })
        creditsLen += credits1.length
        for (const credit1 of credits1) {
          const credits = creditsByCurr[credit1.currency] ??= []
          if (_.last(credits)?.id === credit1.id) continue
          credits.push({
            ..._.pick(credit1, ['id', 'amount', 'period', 'rate', 'side', 'status']),
            openedAt: toUtcDateStr(credit1.mtsOpening),
            closedAt: toUtcDateStr(credit1.mtsLastPayout),
            createdAt: toUtcDateStr(credit1.mtsCreate),
            updatedAt: toUtcDateStr(credit1.mtsUpdate),
          })
          creditEnd = _.min([creditEnd ?? credit1.mtsUpdate, credit1.mtsUpdate])
        }
        if (credits1.length < 500) break
      } catch (err) {
        loggers.log(err)
        break
      }
      await sleep(1000 / 90) // Ratelimit: 90 req/min
    }
    ymlDump('creditsLen', creditsLen)

    for (const [currency, credits2] of _.entries(creditsByCurr)) {
      await writeFile(
        new URL(`${currency}.csv`, outdir),
        Papa.unparse(credits2, { header: true }),
      )
    }
  } catch (err) {
    throw _.update(err, 'data.main', old => old ?? trace)
  }
}

function ymlDump (key: string, val: any): void {
  loggers.log({ [key]: val })
}

class NotMainModuleError extends Error {}
try {
  if (!_.startsWith(import.meta.url, 'file:')) throw new NotMainModuleError()
  const modulePath = fileURLToPath(import.meta.url)
  if (process.argv[1] !== modulePath) throw new NotMainModuleError()
  await main()
} catch (err) {
  if (!(err instanceof NotMainModuleError)) {
    loggers.error(inspect(err))
    process.exit(1)
  }
}
