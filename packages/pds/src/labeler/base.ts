import stream from 'stream'
import PQueue from 'p-queue'
import Database from '../db'
import { BlobStore, cidForRecord } from '@atproto/repo'
import { dedupe, getFieldsFromRecord } from './util'
import { AtUri } from '@atproto/uri'
import { labelerLogger as log } from '../logger'

export abstract class Labeler {
  public db: Database
  public blobstore: BlobStore
  public labelerDid: string
  public processingQueue: PQueue | null // null during teardown
  constructor(opts: {
    db: Database
    blobstore: BlobStore
    labelerDid: string
  }) {
    this.db = opts.db
    this.blobstore = opts.blobstore
    this.labelerDid = opts.labelerDid
    this.processingQueue = new PQueue()
  }

  processRecord(uri: AtUri, obj: unknown) {
    this.processingQueue?.add(() =>
      this.createAndStoreLabels(uri, obj).catch((err) => {
        log.error(
          { err, uri: uri.toString(), record: obj },
          'failed to label record',
        )
      }),
    )
  }

  async createAndStoreLabels(uri: AtUri, obj: unknown): Promise<void> {
    const labels = await this.labelRecord(obj)
    if (labels.length < 1) return
    const cid = await cidForRecord(obj)
    const rows = labels.map((value) => ({
      sourceDid: this.labelerDid,
      subjectUri: uri.toString(),
      subjectCid: cid.toString(),
      value,
      negated: 0 as const,
      createdAt: new Date().toISOString(),
    }))

    await this.db.db
      .insertInto('label')
      .values(rows)
      .onConflict((oc) => oc.doNothing())
      .execute()
  }

  async labelRecord(obj: unknown): Promise<string[]> {
    const { text, imgs } = getFieldsFromRecord(obj)
    const txtLabels = await this.labelText(text.join(' '))
    const imgLabels = await Promise.all(
      imgs.map(async (cid) => {
        const stream = await this.blobstore.getStream(cid)
        return this.labelImg(stream)
      }),
    )
    return dedupe([...txtLabels, ...imgLabels.flat()])
  }

  abstract labelText(text: string): Promise<string[]>
  abstract labelImg(img: stream.Readable): Promise<string[]>

  async processAll() {
    await this.processingQueue?.onIdle()
  }

  async destroy() {
    const pQueue = this.processingQueue
    this.processingQueue = null
    pQueue?.pause()
    pQueue?.clear()
    await pQueue?.onIdle()
  }
}
