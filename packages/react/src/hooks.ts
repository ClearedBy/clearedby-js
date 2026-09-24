// Headless hooks: all the data and actions, none of the markup. Use them to
// build your own UI, or use the default components (which are built on them).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApprovalsError } from './client'
import { useClearedBy } from './context'
import { useResource, type Resource } from './resource'
import type {
  Approval,
  ApprovalPage,
  Decision,
  DecideResult,
  HistoryEvent,
  Permissions,
  ProposeResult,
  Rules,
  RulesSettings,
  RevokeResult,
  ItemStatus,
} from './types'

const enc = encodeURIComponent

/** Cache keys (also the prefixes `useRevalidate()` accepts). */
export const keys = {
  queue: (qs: string) => `items?${qs}`,
  item: (id: string) => `item:${id}`,
  permissions: (id: string) => `permissions:${id}`,
  history: (id: string) => `history:${id}`,
  rules: () => 'rules',
}

/**
 * Refresh open views now. Call it from your own push channel (for example when
 * your backend receives a `decision.*` webhook and tells the browser). Pass a
 * key prefix (`'items'`, `'item:<id>'`, `'rules'`) to refresh only some;
 * nothing refreshes everything.
 */
export function useRevalidate(): (prefix?: string) => Promise<void> {
  const { store } = useClearedBy()
  return useCallback((prefix?: string) => store.revalidate(prefix), [store])
}

// ---- queue ----------------------------------------------------------------------

export interface QueueOptions {
  /** Default: waiting items (`['pending', 'escalated']`). */
  status?: ItemStatus | ItemStatus[]
  filter?: { actionPrefix?: string; batchId?: string }
  /** Page size, 1–100. Default 25. */
  limit?: number
}

export interface ApprovalQueue {
  items: Approval[]
  loading: boolean
  error: unknown
  hasMore: boolean
  loadingMore: boolean
  loadMore: () => Promise<void>
  revalidate: () => Promise<void>
}

/** The signed-in reviewer's queue, newest first. */
export function useApprovalQueue(opts: QueueOptions = {}): ApprovalQueue {
  const { client } = useClearedBy()
  const status = opts.status === undefined ? ['pending', 'escalated'] : Array.isArray(opts.status) ? opts.status : [opts.status]
  const q = new URLSearchParams()
  if (status.length > 0) q.set('status', status.join(','))
  if (opts.filter?.actionPrefix) q.set('action_prefix', opts.filter.actionPrefix)
  if (opts.filter?.batchId) q.set('batch_id', opts.filter.batchId)
  q.set('limit', String(opts.limit ?? 25))
  q.set('include', 'params')
  const qs = q.toString()

  const first = useResource<ApprovalPage>(keys.queue(qs), () => client.get<ApprovalPage>(`/items?${qs}`))
  const [more, setMore] = useState<{ qs: string; items: Approval[]; cursor: string | null } | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)

  // Extra pages belong to one query; a new query starts over.
  const extra = more !== null && more.qs === qs ? more : null
  const cursor = extra !== null ? extra.cursor : first.data?.next_cursor ?? null

  const loadMore = useCallback(async () => {
    if (cursor === null || loadingMore) return
    setLoadingMore(true)
    try {
      const page = await client.get<ApprovalPage>(`/items?${qs}&cursor=${enc(cursor)}`)
      setMore((prev) => ({ qs, items: [...(prev !== null && prev.qs === qs ? prev.items : []), ...page.items], cursor: page.next_cursor }))
    } finally {
      setLoadingMore(false)
    }
  }, [client, qs, cursor, loadingMore])

  const items = useMemo(() => {
    const seen = new Set<string>()
    const out: Approval[] = []
    for (const it of [...(first.data?.items ?? []), ...(extra?.items ?? [])]) {
      if (seen.has(it.id)) continue
      seen.add(it.id)
      out.push(it)
    }
    return out
  }, [first.data, extra])

  return {
    items,
    loading: first.loading && first.data === undefined,
    error: first.error,
    hasMore: cursor !== null,
    loadingMore,
    loadMore,
    revalidate: first.revalidate,
  }
}

// ---- one item -------------------------------------------------------------------

/** One approval in full: the proposed change, evidence, routing, outcome. */
export function useApproval(id: string | null | undefined): Resource<Approval> {
  const { client } = useClearedBy()
  return useResource<Approval>(id ? keys.item(id) : null, () => client.get<Approval>(`/items/${enc(id as string)}`))
}

/** What the signed-in reviewer may do with this item (only show those buttons). */
export function usePermissions(id: string | null | undefined): Resource<Permissions> {
  const { client } = useClearedBy()
  return useResource<Permissions>(id ? keys.permissions(id) : null, () => client.get<Permissions>(`/items/${enc(id as string)}/permissions`))
}

/** The item's timeline, oldest first, including earlier revisions. */
export function useHistory(id: string | null | undefined): Resource<HistoryEvent[]> {
  const { client } = useClearedBy()
  return useResource<HistoryEvent[]>(
    id ? keys.history(id) : null,
    async () => (await client.get<{ events: HistoryEvent[] }>(`/items/${enc(id as string)}/events`)).events,
  )
}

// ---- actions --------------------------------------------------------------------

interface Action<R> {
  pending: boolean
  error: ApprovalsError | null
  result: R | null
  reset: () => void
}

function useAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>): Action<R> & { run: (...args: A) => Promise<R> } {
  const [state, setState] = useState<{ pending: boolean; error: ApprovalsError | null; result: R | null }>({ pending: false, error: null, result: null })
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const fnRef = useRef(fn)
  fnRef.current = fn
  const run = useCallback(async (...args: A) => {
    setState({ pending: true, error: null, result: null })
    try {
      const result = await fnRef.current(...args)
      if (mounted.current) setState({ pending: false, error: null, result })
      return result
    } catch (err) {
      const e = err instanceof ApprovalsError ? err : new ApprovalsError(String(err), 0, 'error')
      if (mounted.current) setState({ pending: false, error: e, result: null })
      throw e
    }
  }, [])
  const reset = useCallback(() => setState({ pending: false, error: null, result: null }), [])
  return { ...state, run, reset }
}

export interface DecideOptions {
  /** Required (4+ characters) to decline or send back. */
  reason?: string
  /** Hand it to a specific person (your id for them). Otherwise the most senior reviewer who can cover it. */
  escalateTo?: string
}

export const REASON_REQUIRED: readonly Decision[] = ['reject', 'send_back']
export const MIN_REASON_LENGTH = 4

export interface UseDecide extends Action<DecideResult> {
  decide: (decision: Decision, opts?: DecideOptions) => Promise<DecideResult>
}

/**
 * Approve / decline / send back / ask someone else. A decline or send-back
 * without a reason is refused here, before anything is sent. Refreshes every
 * open view afterwards.
 */
export function useDecide(id: string): UseDecide {
  const { client, store } = useClearedBy()
  const a = useAction(async (decision: Decision, opts: DecideOptions = {}) => {
    const reason = opts.reason?.trim() ?? ''
    if (REASON_REQUIRED.includes(decision) && reason.length < MIN_REASON_LENGTH) {
      throw new ApprovalsError('a reason is required', 400, 'reason_required')
    }
    const result = await client.send<DecideResult>('POST', `/items/${enc(id)}/decide`, {
      decision,
      ...(reason !== '' ? { reason } : {}),
      ...(decision === 'escalate' && opts.escalateTo ? { escalate_to: opts.escalateTo } : {}),
    })
    void store.revalidate()
    return result
  })
  return { pending: a.pending, error: a.error, result: a.result, reset: a.reset, decide: a.run }
}

export interface UseRevoke extends Action<RevokeResult> {
  /** Cancel an approved change before it runs. `reason` is required (4+ characters). */
  revoke: (reason: string) => Promise<RevokeResult>
}

export function useRevoke(id: string): UseRevoke {
  const { client, store } = useClearedBy()
  const a = useAction(async (reason: string) => {
    if (reason.trim().length < MIN_REASON_LENGTH) throw new ApprovalsError('a reason is required', 400, 'reason_required')
    const result = await client.send<RevokeResult>('POST', `/items/${enc(id)}/revoke`, { reason: reason.trim() })
    void store.revalidate()
    return result
  })
  return { pending: a.pending, error: a.error, result: a.result, reset: a.reset, revoke: a.run }
}

// ---- rules ----------------------------------------------------------------------

/** The merchant's approval rules in plain English, plus who is looking. */
export function useRules(): Resource<Rules> {
  const { client } = useClearedBy()
  return useResource<Rules>(keys.rules(), () => client.get<Rules>('/rules'), { poll: false })
}

export interface UseRulesProposal {
  pending: boolean
  error: ApprovalsError | null
  /** Change some settings. Stricter: on at once. Looser: a proposal an owner must accept. */
  propose: (settings: Partial<RulesSettings>) => Promise<ProposeResult>
  /** An owner/admin accepts a looser proposal. */
  accept: (proposalId: string) => Promise<{ status: 'active' }>
  proposal: ProposeResult | null
  reset: () => void
}

export function useRulesProposal(): UseRulesProposal {
  const { client, store } = useClearedBy()
  const p = useAction(async (settings: Partial<RulesSettings>) => {
    const r = await client.send<ProposeResult>('PUT', '/rules', { settings })
    void store.revalidate('rules')
    return r
  })
  const acc = useAction(async (proposalId: string) => {
    const r = await client.send<{ status: 'active' }>('POST', `/rules/proposals/${enc(proposalId)}/accept`, {})
    void store.revalidate('rules')
    return r
  })
  return {
    pending: p.pending || acc.pending,
    error: p.error ?? acc.error,
    propose: p.run,
    accept: acc.run,
    proposal: p.result,
    reset: () => {
      p.reset()
      acc.reset()
    },
  }
}
