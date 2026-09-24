import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { ClearedByProvider, useApproval, useApprovalQueue, useDecide, useRevalidate, useRulesProposal } from '../src'
import { baseItem, fakeProxy } from './fixtures'

const wrap = (fetch: typeof globalThis.fetch, pollInterval = 0) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return <ClearedByProvider basePath="/api/clearedby" fetch={fetch} pollInterval={pollInterval} fetchTheme={false}>{children}</ClearedByProvider>
  }

const setHidden = (hidden: boolean) => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') })
  document.dispatchEvent(new Event('visibilitychange'))
}

afterEach(() => setHidden(false))

describe('hooks', () => {
  it('useApprovalQueue loads waiting items from the proxy, with paging', async () => {
    const api = fakeProxy({
      'GET /items': (_b, _p) => ({ items: [baseItem({ id: 'a' }), baseItem({ id: 'b' })], next_cursor: 'c1' }),
    })
    const { result } = renderHook(() => useApprovalQueue(), { wrapper: wrap(api.fetch) })
    await waitFor(() => expect(result.current.items).toHaveLength(2))
    expect(api.calls[0]!.path).toContain('status=pending%2Cescalated')
    expect(api.calls[0]!.path).toContain('include=params')
    expect(result.current.hasMore).toBe(true)
    await act(() => result.current.loadMore())
    expect(api.calls.at(-1)!.path).toContain('cursor=c1')
    // Same items again on page 2 are de-duplicated.
    expect(result.current.items.map((i) => i.id)).toEqual(['a', 'b'])
  })

  it('useDecide refuses decline / send back without a reason before calling the server', async () => {
    const api = fakeProxy({ 'POST /items/item_1/decide': () => ({ status: 'rejected' }) })
    const { result } = renderHook(() => useDecide('item_1'), { wrapper: wrap(api.fetch) })
    for (const decision of ['reject', 'send_back'] as const) {
      await act(async () => {
        await expect(result.current.decide(decision, { reason: ' no ' })).rejects.toMatchObject({ code: 'reason_required' })
      })
    }
    expect(api.calls).toHaveLength(0)
    await act(async () => {
      await result.current.decide('reject', { reason: 'already refunded' })
    })
    expect(api.calls[0]).toMatchObject({ method: 'POST', path: '/items/item_1/decide', body: { decision: 'reject', reason: 'already refunded' } })
    expect(result.current.result).toEqual({ status: 'rejected' })
  })

  it('useDecide sends escalate_to only with escalate, and surfaces server refusals', async () => {
    const api = fakeProxy({
      'POST /items/item_1/decide': (b) => (b.decision === 'clear'
        ? { status: 403, body: { error: { code: 'no_authority', message: 'over the limit' } } }
        : { status: 'escalated' }),
    })
    const { result } = renderHook(() => useDecide('item_1'), { wrapper: wrap(api.fetch) })
    await act(async () => {
      await result.current.decide('escalate', { escalateTo: 'bob' })
    })
    expect(api.calls[0]!.body).toEqual({ decision: 'escalate', escalate_to: 'bob' })
    await act(async () => {
      await result.current.decide('clear', { escalateTo: 'bob' }).catch(() => undefined)
    })
    expect(api.calls[1]!.body).toEqual({ decision: 'clear' })
    expect(result.current.error).toMatchObject({ status: 403, code: 'no_authority' })
  })

  it('a decision refreshes the open views, and revalidate() does too', async () => {
    let status = 'pending'
    const api = fakeProxy({
      'GET /items/item_1': () => baseItem({ status: status as 'pending' }),
      'POST /items/item_1/decide': () => {
        status = 'cleared'
        return { status: 'cleared' }
      },
    })
    const { result } = renderHook(() => ({ item: useApproval('item_1'), decide: useDecide('item_1'), revalidate: useRevalidate() }), {
      wrapper: wrap(api.fetch),
    })
    await waitFor(() => expect(result.current.item.data?.status).toBe('pending'))
    await act(async () => {
      await result.current.decide.decide('clear')
    })
    await waitFor(() => expect(result.current.item.data?.status).toBe('cleared'))
    const before = api.calls.filter((c) => c.path === '/items/item_1').length
    await act(() => result.current.revalidate('item:'))
    expect(api.calls.filter((c) => c.path === '/items/item_1').length).toBe(before + 1)
  })

  it('polls while visible, pauses while the tab is hidden, and refreshes on return', async () => {
    const api = fakeProxy({ 'GET /items/item_1': () => baseItem() })
    renderHook(() => useApproval('item_1'), { wrapper: wrap(api.fetch, 40) })
    await waitFor(() => expect(api.calls.length).toBeGreaterThanOrEqual(3), { timeout: 2000 })
    act(() => setHidden(true))
    await new Promise((r) => setTimeout(r, 60))
    const whileHidden = api.calls.length
    await new Promise((r) => setTimeout(r, 200))
    expect(api.calls.length).toBe(whileHidden)
    act(() => setHidden(false))
    await waitFor(() => expect(api.calls.length).toBeGreaterThan(whileHidden))
  })

  it('backs off after errors', async () => {
    const api = fakeProxy({ 'GET /items/item_1': () => ({ status: 500, body: { error: { code: 'boom', message: 'x' } } }) })
    const { result } = renderHook(() => useApproval('item_1'), { wrapper: wrap(api.fetch, 30) })
    await waitFor(() => expect(result.current.error).toBeDefined())
    await new Promise((r) => setTimeout(r, 400))
    // Without backoff ~13 calls in 400ms; with doubling (30, 60, 120, 240…) at most ~5.
    expect(api.calls.length).toBeLessThanOrEqual(6)
  })

  it('useRulesProposal proposes and accepts', async () => {
    const api = fakeProxy({
      'PUT /rules': () => ({ status: 202, body: { status: 'needs_owner_approval', proposal_id: 'p1', proposal_version: 3, strictness: 'looser', summary_diff: [], summary: [] } }),
      'POST /rules/proposals/p1/accept': () => ({ status: 'active' }),
    })
    const { result } = renderHook(() => useRulesProposal(), { wrapper: wrap(api.fetch) })
    let res: unknown
    await act(async () => {
      res = await result.current.propose({ refund_auto_max: 50 })
    })
    expect(res).toMatchObject({ status: 'needs_owner_approval', proposal_id: 'p1' })
    expect(api.calls[0]).toMatchObject({ method: 'PUT', path: '/rules', body: { settings: { refund_auto_max: 50 } } })
    await act(async () => {
      await result.current.accept('p1')
    })
    expect(api.calls[1]).toMatchObject({ method: 'POST', path: '/rules/proposals/p1/accept' })
  })
})
