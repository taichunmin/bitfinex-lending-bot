import _ from 'lodash'
import { getenv } from '@/lib/dotenv'
import { z } from '@/lib/zod'
import type { ZodAny } from 'zod'

const TELEGRAM_TOKEN = getenv('TELEGRAM_TOKEN')
const TELEGRAM_CHAT_ID = getenv('TELEGRAM_CHAT_ID')

export const ZodJsonValue = z.json()
type JsonValue = z.output<typeof ZodJsonValue>

const ZodUnixtimeToDate = z.codec(z.int().min(0), z.date(), {
  decode: unixtime => new Date(unixtime * 1000),
  encode: (date) => Math.trunc(date.getTime() / 1000),
})

export const ZodTelegramPostResp = z.looseObject({
  ok: z.boolean(),
  description: z.string().optional(),
  error_code: z.number().optional(),
  migrate_to_chat_id: z.number().optional(),
  retry_after: z.number().optional(),
})
export type TelegramPostResp = z.output<typeof ZodTelegramPostResp>

export const ZodTelegramUser = z.looseObject({
  id: z.number(),
  is_bot: z.boolean(),
  first_name: z.string(),
  last_name: z.string().optional(),
  username: z.string().optional(),
  language_code: z.string().optional(),
  is_premium: z.boolean().optional(),
  added_to_attachment_menu: z.boolean().optional(),
  can_join_groups: z.boolean().optional(),
  can_read_all_group_messages: z.boolean().optional(),
  supports_inline_queries: z.boolean().optional(),
  can_connect_to_business: z.boolean().optional(),
  has_main_web_app: z.boolean().optional(),
  has_topics_enabled: z.boolean().optional(),
})
export type TelegramUser = z.output<typeof ZodTelegramUser>

export const ZodTelegramChat = z.looseObject({
  id: z.number(),
  type: z.enum(['private', 'group', 'supergroup', 'channel']),
  title: z.string().optional(),
  username: z.string().optional(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  is_forum: z.boolean().optional(),
  is_direct_messages: z.boolean().optional(),
  all_members_are_administrators: z.boolean().optional(),
})

export const ZodTelegramMessage = z.looseObject({
  message_id: z.number(),
  message_thread_id: z.number().optional(),
  direct_messages_topic: z.any().optional(),
  from: ZodTelegramUser.optional(),
  sender_chat: ZodTelegramChat.optional(),
  sender_boost_count: z.number().optional(),
  sender_business_bot: z.any().optional(),
  date: ZodUnixtimeToDate,
  edit_date: ZodUnixtimeToDate,
  business_connection_id: z.string().optional(),
  chat: ZodTelegramChat,
  forward_origin: z.any().optional(),
  is_topic_message: z.boolean().optional(),
  is_automatic_forward: z.boolean().optional(),
  reply_to_message: z.any().optional(),
  external_reply: z.any().optional(),
  quote: z.any().optional(),
  text: z.string().optional(),
})
export type TelegramMessage = z.output<typeof ZodTelegramMessage>

export const ZodTelegramUpdate = z.object({
  update_id: z.number(),
  message: z.any().optional(),
})
export type TelegramUpdate = z.output<typeof ZodTelegramUpdate>

async function telegramPost <
  TReq extends JsonValue | ZodAny = JsonValue | ZodAny,
  TRes extends TelegramPostResp = TelegramPostResp,
> (path: string, body: TReq): Promise<TRes> {
  if (_.isNil(TELEGRAM_TOKEN)) throw new Error('TELEGRAM_TOKEN is not set')
  try {
    const resp = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/${path}`, {
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    })
    const respJson = await resp.json().catch(() => null) as TelegramPostResp // catch all error
    if (!resp.ok) {
      const errMsg = _.isNil(respJson) ? `HTTP ${resp.status}: ${resp.statusText}` : `Telegram API ${respJson.error_code}: ${respJson.description}`
      throw _.update(new Error(errMsg), 'data.telegramPost', orig => ({ ...orig, resp, respJson }))
    }
    return respJson as TRes
  } catch (err) {
    throw _.update(err, 'data.telegramPost', orig => ({ ...orig, method: 'POST', path, body }) )
  }
}

export async function sendMessage (body: Record<string, JsonValue>): Promise<TelegramMessage> {
  // await telegram.sendMessage({ text: 'Hello world.' })
  if (_.isNil(TELEGRAM_CHAT_ID)) throw new Error('TELEGRAM_CHAT_ID is not set')
  const resp = await telegramPost('sendMessage', { chat_id: TELEGRAM_CHAT_ID, ...body })
  return ZodTelegramMessage.parse(resp.result)
}

export const ZodTelegramMessageEntity = z.looseObject({
  type: z.string(),
  offset: z.number(),
  length: z.number(),
})

export const ZodTelegramLinkPreviewOptions = z.looseObject({
  is_disabled: z.boolean().optional(),
  url: z.string().optional(),
  prefer_small_media: z.boolean().optional(),
  prefer_large_media: z.boolean().optional(),
  show_above_text: z.boolean().optional(),
})

export const ZodEditMessageTextReq = z.object({
  business_connection_id: z.string().optional(),
  chat_id: z.union([z.int(), z.string()]).optional(),
  message_id: z.int().optional(),
  inline_message_id: z.string().optional(),
  text: z.string(),
  parse_mode: z.enum(['MarkdownV2', 'HTML', 'Markdown']).optional(),
  entities: z.array(ZodTelegramMessageEntity).optional(),
  link_preview_options: ZodTelegramLinkPreviewOptions.optional(),
  reply_markup: z.any().optional(),
})
export type EditMessageTextReq = z.output<typeof ZodEditMessageTextReq>

export const ZodEditMessageTextRes = z.union([z.boolean(), ZodTelegramMessage])
export type EditMessageTextRes = z.output<typeof ZodEditMessageTextRes>

export async function editMessageText (req: z.input<typeof ZodEditMessageTextReq>): Promise<EditMessageTextRes>
export async function editMessageText (req: EditMessageTextReq): Promise<EditMessageTextRes> {
  if (_.isNil(TELEGRAM_CHAT_ID)) throw new Error('TELEGRAM_CHAT_ID is not set')

  req = ZodEditMessageTextReq.parse(req)
  const res = await telegramPost('editMessageText', req as JsonValue)
  return ZodEditMessageTextRes.parse(res.result)
}
