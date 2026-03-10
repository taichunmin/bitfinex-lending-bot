// import first before other imports
import { getenv } from '@/lib/dotenv'

import _ from 'lodash'
import { createLoggersByUrl } from '@/lib/logger'
import * as BitfinexLib from '@taichunmin/bitfinex'
import Repl from 'node:repl'

const loggers = createLoggersByUrl(import.meta.url)
const bitfinex = new BitfinexLib.Bitfinex({
  apiKey: getenv('BITFINEX_API_KEY'),
  apiSecret: getenv('BITFINEX_API_SECRET'),
  affCode: getenv('BITFINEX_AFF_CODE'),
})

const repl = Repl.start({
  breakEvalOnSigint: true,
  ignoreUndefined: true,
  prompt: `${getenv('NODE_ENV', 'dev')}> `,
  useGlobal: true,
})
repl.setupHistory('.node_repl_history', (err, r) => {
  if (!_.isNil(err)) loggers.error(err)
})

_.merge(repl.context, { ...BitfinexLib, loggers, bitfinex })
_.merge(repl.context.process.env, {
  DEBUG_COLORS: true,
})
