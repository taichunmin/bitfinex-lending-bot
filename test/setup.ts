import { vi } from 'vitest'

// 測試一律不碰真實 API／金鑰：外部相依由各測試檔自行 `vi.mock`。
// 這裡只塞假的環境變數，避免 import SUT 時 top-level 讀 env 出問題。
vi.stubEnv('NODE_ENV', 'test')
vi.stubEnv('BITFINEX_API_KEY', 'test-key')
vi.stubEnv('BITFINEX_API_SECRET', 'test-secret')
vi.stubEnv('BITFINEX_AFF_CODE', 'test-aff')
vi.stubEnv('TELEGRAM_TOKEN', 'test-telegram-token')
vi.stubEnv('TELEGRAM_CHAT_ID', '-100')
