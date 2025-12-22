import { getenv } from './dotenv.js'

import { Octokit } from 'octokit'
import _ from 'lodash'
import pkg from '../package.json' assert { type: 'json' }
import { z } from '@/lib/zod'
export { Octokit }

const OCTOKIT_ACCESS_TOKEN = getenv('OCTOKIT_ACCESS_TOKEN')

// init octokit
let octokit: Octokit | null = null
if (_.isString(OCTOKIT_ACCESS_TOKEN)) {
  octokit = new Octokit({
    auth: OCTOKIT_ACCESS_TOKEN,
    timeZone: 'Asia/Taipei',
    userAgent: `${pkg.name}/v${pkg.version}`,
  })
}
export { octokit }

// zod
const ZodGistCreateFile = z.object({
  content: z.string(),
})
const ZodGistCreateOptions = z.object({
  description: z.string().optional(),
  files: z.record(z.string(), ZodGistCreateFile),
  public: z.boolean().optional(),
})
const ZodGistUpdateFile = z.object({
  content: z.string(),
  filename: z.string().optional(),
})
const ZodGistUpdateOptions = z.object({
  description: z.string().optional(),
  files: z.record(z.string(), ZodGistUpdateFile),
})

export class Gist {
  gistId: string
  octokit: Octokit

  constructor (gistId: string) {
    if (_.isNil(octokit)) throw new Error('OCTOKIT_ACCESS_TOKEN is not set')
    this.gistId = gistId
    this.octokit = octokit
  }

  /**
   * @see
   * - https://docs.github.com/en/rest/gists/gists?apiVersion=2022-11-28#create-a-gist
   * - https://octokit.github.io/rest.js/v22/#gists
   */
  static async create (opts: z.input<typeof ZodGistCreateOptions>): Promise<Gist>
  static async create (opts: z.output<typeof ZodGistCreateOptions>): Promise<Gist> {
    if (_.isNil(octokit)) throw new Error('OCTOKIT_ACCESS_TOKEN is not set')

    opts = ZodGistCreateOptions.parse(opts)
    const rawgist = await octokit.rest.gists.create(opts)
    const gistId = rawgist.data.id
    if (!_.isString(gistId)) throw new Error('Failed to create gist')
    return new Gist(gistId)
  }

  /**
   * @see
   * - https://octokit.github.io/rest.js/v22/#gists-get
   * - https://docs.github.com/en/rest/gists/gists?apiVersion=2022-11-28#get-a-gist
   */
  async get (mimeType?: string): ReturnType<Octokit['rest']['gists']['get']> {
    const opts = { gist_id: this.gistId }
    if (_.isString(mimeType)) _.set(opts, 'headers.Accept', mimeType)
    return await this.octokit.rest.gists.get(opts)
  }

  /**
   * @see
   * - https://octokit.github.io/rest.js/v22/#gists-update
   * - https://docs.github.com/en/rest/gists/gists?apiVersion=2022-11-28#update-a-gist
   */
  async update (opts: z.input<typeof ZodGistUpdateOptions>): Promise<void>
  async update (opts: z.output<typeof ZodGistUpdateOptions>): Promise<void> {
    opts = ZodGistUpdateOptions.parse(opts)
    await this.octokit.rest.gists.update({
      gist_id: this.gistId,
      ...opts,
    })
  }
}
