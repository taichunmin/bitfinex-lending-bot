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
import { dayjs } from '@/lib/dayjs'
import { toUtcDateStr, writeFile } from '@/lib/helper'
import { createLoggersByUrl } from '@/lib/logger'
import { Bitfinex, PlatformStatus } from '@taichunmin/bitfinex'
import _ from 'lodash'
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

export async function main (argv: string[]): Promise<void> {
  const trace: Record<string, any> = { argv }
  ymlDump('argv', argv)

  try {
    if ((await Bitfinex.v2PlatformStatus()).status === PlatformStatus.MAINTENANCE) {
      loggers.error('Bitfinex API is in maintenance mode')
      return
    }

    const months = _.filter(argv, m => dayjs.utc(m, 'YYYY-MM', true).isValid())
    if (months.length === 0) {
      months.push(...[
        dayjs.utc().add(-1, 'month').format('YYYY-MM'),
        dayjs.utc().format('YYYY-MM'),
      ])
    }

    let createdFiles = 0
    for (const month of months) {
      try {
        const monthStart = trace.monthStart = dayjs.utc(month).startOf('month').toDate()
        const monthEnd = trace.monthEnd = dayjs.utc(month).endOf('month').toDate()
        let creditEnd = dayjs.utc(month).endOf('month').add(5, 'day').toDate()
        let credits = []
        while (true) {
          const credits1 = await bitfinex.v2AuthReadFundingCreditsHist({
            start: monthStart,
            end: creditEnd,
            limit: 500,
          })
          // console.log(`credits1.length = ${credits1.length}`)
          credits.push(...credits1)
          if (credits1.length < 500) break
          creditEnd = dayjs.utc(credits1[credits1.length - 1].mtsCreate).toDate()
        }
        // console.log(`credits.length = ${credits.length}`)

        // convert to lookerstudio csv
        credits = _.chain(credits)
          .uniqBy('id')
          .filter(credit => credit.mtsOpening <= monthEnd && credit.mtsLastPayout >= monthStart)
          .map(credit => ({
            ..._.pick(credit, ['id', 'amount', 'currency', 'period', 'rate', 'side', 'status']),
            openedAt: toUtcDateStr(credit.mtsOpening),
            closedAt: toUtcDateStr(credit.mtsLastPayout),
            createdAt: toUtcDateStr(credit.mtsCreate),
            updatedAt: toUtcDateStr(credit.mtsUpdate),
          }))
          .orderBy(['id'], ['asc'])
          .value()

        for (const [currency, credits2] of _.entries(_.groupBy(credits, 'currency'))) {
          await writeFile(
            new URL(`${month}/${currency}.csv`, outdir),
            Papa.unparse(credits2, { header: true }),
          )
          createdFiles++
        }
      } catch (err) {
        _.update(err, 'data.loopmonth', old => old ?? trace)
        loggers.error(err)
      }
    }
    ymlDump('createdFiles', createdFiles)
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
  await main(process.argv.slice(2))
} catch (err) {
  if (!(err instanceof NotMainModuleError)) {
    loggers.error(inspect(err))
    process.exit(1)
  }
}
