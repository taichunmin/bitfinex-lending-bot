import { z } from 'zod'
export { z }

export const ZodJsonValue = z.json()
export type JsonValue = z.output<typeof ZodJsonValue>
