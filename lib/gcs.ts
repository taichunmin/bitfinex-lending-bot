import { Storage } from '@google-cloud/storage'
import { z } from '@/lib/zod'
import _ from 'lodash'
import Papa from 'papaparse'

export const storage = new Storage()

const ZodUploadCsvOpts = z.object({
  bucketName: z.string().trim(),
  filePath: z.string().trim(),
  rows: z.array(z.record(z.string(), z.unknown())),
  maxAge: z.int().nonnegative().default(30),
})

export async function uploadCsv (opts: z.input<typeof ZodUploadCsvOpts>): Promise<void> {
  const trace: Record<string, any> = { opts }
  try {
    const opts1 = trace.opts = ZodUploadCsvOpts.parse(opts)
    const storage = new Storage()
    const data = Papa.unparse(opts1.rows, { header: true })
    await storage.bucket(opts1.bucketName).file(opts1.filePath).save(data, {
      gzip: true,
      validation: 'crc32c',
      metadata: {
        cacheControl: `public, max-age=${opts1.maxAge}`,
        contentLanguage: 'zh',
        contentType: 'text/csv',
      },
    })
  } catch (err) {
    throw _.update(err, 'data.uploadCsv', old => old ?? trace)
  }
}
