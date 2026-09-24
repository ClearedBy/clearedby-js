// A tiny keyed cache shared by every hook under one <ClearedByProvider>, so the
// queue, the review panel and the decision bar never fetch the same thing twice
// and all update together. Deliberately small: dedupe in-flight loads, notify
// subscribers, revalidate by key prefix.

interface Entry {
  data: unknown
  error: unknown
  loading: boolean
  inflight: Promise<void> | null
  loader: (() => Promise<unknown>) | null
  updatedAt: number
  listeners: Set<() => void>
}

export class ResourceStore {
  private entries = new Map<string, Entry>()

  entry(key: string): Entry {
    let e = this.entries.get(key)
    if (e === undefined) {
      e = { data: undefined, error: undefined, loading: false, inflight: null, loader: null, updatedAt: 0, listeners: new Set() }
      this.entries.set(key, e)
    }
    return e
  }

  subscribe(key: string, fn: () => void): () => void {
    const e = this.entry(key)
    e.listeners.add(fn)
    return () => {
      e.listeners.delete(fn)
    }
  }

  private notify(e: Entry): void {
    for (const fn of [...e.listeners]) fn()
  }

  /**
   * Load `key`. A load already in flight is shared. Without `force`, data
   * fetched in the last `freshMs` is reused.
   */
  load(key: string, loader: () => Promise<unknown>, opts: { force?: boolean; freshMs?: number } = {}): Promise<void> {
    const e = this.entry(key)
    e.loader = loader
    // A forced load (after a decision) must not settle for a response that was
    // already on its way before the change: queue one more behind it.
    if (e.inflight !== null) {
      return opts.force === true ? e.inflight.then(() => this.load(key, loader, { force: true })) : e.inflight
    }
    if (opts.force !== true && e.updatedAt > 0 && Date.now() - e.updatedAt < (opts.freshMs ?? 2000)) return Promise.resolve()
    e.loading = true
    this.notify(e)
    const p = loader().then(
      (data) => {
        e.data = data
        e.error = undefined
      },
      (err: unknown) => {
        e.error = err
      },
    ).finally(() => {
      e.loading = false
      e.inflight = null
      e.updatedAt = Date.now()
      this.notify(e)
    })
    e.inflight = p
    return p
  }

  /** Replace cached data (e.g. after a write returns the new state). */
  set(key: string, data: unknown): void {
    const e = this.entry(key)
    e.data = data
    e.error = undefined
    e.updatedAt = Date.now()
    this.notify(e)
  }

  /**
   * Re-fetch every mounted resource whose key starts with `prefix` (all of
   * them when omitted). Unmounted entries are just marked stale.
   */
  revalidate(prefix?: string): Promise<void> {
    const jobs: Promise<void>[] = []
    for (const [key, e] of this.entries) {
      if (prefix !== undefined && !key.startsWith(prefix)) continue
      if (e.listeners.size > 0 && e.loader !== null) jobs.push(this.load(key, e.loader, { force: true }))
      else e.updatedAt = 0
    }
    return Promise.all(jobs).then(() => undefined)
  }
}
