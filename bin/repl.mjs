// import first before other imports
import { getenv } from '../lib/dotenv.mjs'

import _ from 'lodash'
import { createLoggersByUrl } from '../lib/logger.mjs'
import * as bitfinex from '../lib/bitfinex.mjs'
import Repl from 'repl'

const loggers = createLoggersByUrl(import.meta.url)

const repl = Repl.start({
  breakEvalOnSigint: true,
  ignoreUndefined: true,
  prompt: `${getenv('NODE_ENV', 'dev')}> `,
  useGlobal: true,
})
repl.setupHistory?.('.node_repl_history', (err, r) => {
  if (!_.isNil(err)) loggers.error(err)
})

_.merge(repl.context, { bitfinex, loggers })
_.merge(repl.context.process.env, {
  DEBUG_COLORS: true,
})
