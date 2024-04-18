import _ from 'lodash'
import { getenv } from './dotenv.mjs'

const TELEGRAM_TOKEN = getenv('TELEGRAM_TOKEN')
const TELEGRAM_CHAT_ID = getenv('TELEGRAM_CHAT_ID')

async function telegramPost (path, body) {
  if (_.isNil(TELEGRAM_TOKEN)) throw new Error('TELEGRAM_TOKEN is not set')
  try {
    const resp = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/${path}`, {
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    })
    const respJson = await resp.json().catch(() => null) // catch all error
    if (resp.ok !== true || respJson?.ok !== true) {
      const errMsg = _.isNil(respJson) ? `HTTP ${resp.status}: ${resp.statusText}` : `Telegram API ${respJson?.error_code}: ${respJson?.description}`
      throw _.merge(new Error(errMsg), { data: { respJson } })
    }
  } catch (err) {
    throw _.merge(err, { data: { method: 'POST', path, body } })
  }
}

export async function sendMessage (body) {
  // await telegram.sendMessage({ text: 'Hello world.' })
  await telegramPost('sendMessage', { chat_id: TELEGRAM_CHAT_ID, ...body })
}
