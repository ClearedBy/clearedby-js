import { useCallback, useEffect, useReducer, useRef } from 'react'
import { useClearedBy } from './context'

const MAX_BACKOFF_MS = 5 * 60_000

export interface Resource<T> {
  data: T | undefined
  error: unknown
  /** True while a request for this resource is in flight (including refreshes). */
  loading: boolean
  /** Fetch again now. */
  revalidate: () => Promise<void>
}

const isHidden = (): boolean => typeof document !== 'undefined' && document.visibilityState === 'hidden'

/**
 * Subscribe to one cached resource. Loads on mount (sharing an in-flight or
 * fresh copy), then polls every `pollInterval` while the tab is visible,
 * doubling the wait after each error (up to 5 minutes), and refreshes as soon
 * as the tab becomes visible again. `key: null` = don't load.
 */
export function useResource<T>(key: string | null, loader: () => Promise<T>, opts: { poll?: boolean } = {}): Resource<T> {
  const { store, pollInterval } = useClearedBy()
  const [, rerender] = useReducer((n: number) => n + 1, 0)
  const loaderRef = useRef(loader)
  loaderRef.current = loader
  const poll = opts.poll !== false && pollInterval > 0

  useEffect(() => {
    if (key === null) return undefined
    const unsubscribe = store.subscribe(key, rerender)
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let delay = pollInterval
    // Several components polling the same key share one request per half-interval.
    const run = () => store.load(key, () => loaderRef.current(), { freshMs: pollInterval / 2 })

    const schedule = () => {
      if (cancelled || !poll || isHidden()) return
      timer = setTimeout(tick, delay)
    }
    const tick = async () => {
      timer = undefined
      if (cancelled) return
      if (isHidden()) return // resumes on visibilitychange
      await run()
      delay = store.entry(key).error !== undefined ? Math.min(delay * 2, MAX_BACKOFF_MS) : pollInterval
      schedule()
    }
    const onVisibility = () => {
      if (isHidden()) {
        if (timer !== undefined) clearTimeout(timer)
        timer = undefined
      } else if (timer === undefined) {
        void tick()
      }
    }

    void store.load(key, () => loaderRef.current()).then(schedule)
    if (poll && typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
      unsubscribe()
    }
  }, [key, store, poll, pollInterval])

  const revalidate = useCallback(
    () => (key === null ? Promise.resolve() : store.load(key, () => loaderRef.current(), { force: true })),
    [key, store],
  )

  const e = key === null ? undefined : store.entry(key)
  return {
    data: e?.data as T | undefined,
    error: e?.error,
    loading: e === undefined ? false : e.loading || (e.updatedAt === 0 && e.data === undefined && e.error === undefined),
    revalidate,
  }
}
