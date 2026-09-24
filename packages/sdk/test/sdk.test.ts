import { describe, expect, it, vi } from 'vitest'
import { ClearedBy, RejectedError, ClearedByError, TestItemError } from '../src/index'

// Build a fake fetch that returns queued responses in order.
function fakeFetch(responses: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; init: any }> = []
  let i = 0
  const f = (async (url: string, init: any) => {
    calls.push({ url, init })
    const r = responses[Math.min(i, responses.length - 1)]!
    i++
    return { status: r.status, json: async () => r.body }
  }) as unknown as typeof fetch
  return { f, calls }
}

const client = (f: typeof fetch) => new ClearedBy({ apiKey: 'cb_live_test', baseUrl: 'https://api.test', fetch: f })

describe('ClearedBy.catalogue', () => {
  it('GETs /v1/catalogue with Bearer auth and returns the body', async () => {
    const body = { shopify: { version: 'v', namespace: 'shopify', conventions: {}, actions: [{ action: 'shopify.refund.create' }] } }
    const { f, calls } = fakeFetch([{ status: 200, body }])
    const r = await client(f).catalogue()
    expect(r).toEqual(body)
    expect(calls[0]!.url).toBe('https://api.test/v1/catalogue')
    expect(calls[0]!.init.method).toBe('GET')
    expect(calls[0]!.init.headers.authorization).toBe('Bearer cb_live_test')
  })
  it('throws ClearedByError on a non-200', async () => {
    const { f } = fakeFetch([{ status: 401, body: { error: { message: 'bad key', code: 'unauthorized' } } }])
    await expect(client(f).catalogue()).rejects.toMatchObject({ status: 401, code: 'unauthorized' })
  })
})

describe('ClearedBy.gate', () => {
  it('sends Bearer auth + maps a cleared verdict', async () => {
    const { f, calls } = fakeFetch([{ status: 200, body: { id: 'wi1', status: 'cleared', decided_by: 'policy:auto' } }])
    const r = await client(f).gate({ action: 'refund.create', params: { amount: 50 } })
    expect(r.status).toBe('cleared')
    expect(calls[0]!.url).toBe('https://api.test/v1/gate')
    expect(calls[0]!.init.headers.authorization).toBe('Bearer cb_live_test')
    expect(JSON.parse(calls[0]!.init.body)).toMatchObject({ action: 'refund.create', params: { amount: 50 } })
  })
  it('throws ClearedByError on a non-2xx', async () => {
    const { f } = fakeFetch([{ status: 401, body: { error: { message: 'bad key', code: 'unauthorized' } } }])
    await expect(client(f).gate({ action: 'x' })).rejects.toBeInstanceOf(ClearedByError)
  })
})

describe('ClearedBy.guard', () => {
  it('runs fn when cleared', async () => {
    const { f } = fakeFetch([{ status: 200, body: { id: 'wi1', status: 'cleared' } }])
    const out = await client(f).guard({ action: 'refund.create' }, () => 'ran')
    expect(out).toBe('ran')
  })
  it('runs fn in shadow mode without blocking', async () => {
    const { f } = fakeFetch([{ status: 200, body: { id: 'wi1', status: 'cleared', shadow: true, would: { verdict: 'review', rule: 'r' } } }])
    const out = await client(f).guard({ action: 'refund.create' }, () => 'ran')
    expect(out).toBe('ran')
  })
  it('throws RejectedError when rejected', async () => {
    const { f } = fakeFetch([{ status: 200, body: { id: 'wi1', status: 'rejected', reason: 'over limit' } }])
    await expect(client(f).guard({ action: 'refund.create' }, () => 'ran')).rejects.toBeInstanceOf(RejectedError)
  })
  it('waits through pending → cleared, then runs fn', async () => {
    const { f } = fakeFetch([
      { status: 202, body: { id: 'wi1', status: 'pending' } }, // gate
      { status: 200, body: { id: 'wi1', status: 'pending' } }, // wait poll 1
      { status: 200, body: { id: 'wi1', status: 'cleared' } }, // wait poll 2
    ])
    const out = await client(f).guard({ action: 'refund.create' }, () => 'ran')
    expect(out).toBe('ran')
  })
  it('waits through pending → rejected, then throws', async () => {
    const { f } = fakeFetch([
      { status: 202, body: { id: 'wi1', status: 'pending' } },
      { status: 200, body: { id: 'wi1', status: 'rejected', reason: 'no' } },
    ])
    await expect(client(f).guard({ action: 'refund.create' }, () => 'ran')).rejects.toBeInstanceOf(RejectedError)
  })
  // CLE-221: a test item never authorizes anything, even once approved.
  it('rejects a test item that clears immediately, without running fn', async () => {
    const { f } = fakeFetch([{ status: 200, body: { id: 'wi1', status: 'cleared', test: true } }])
    const fn = vi.fn(() => 'ran')
    await expect(client(f).guard({ action: 'refund.create' }, fn)).rejects.toBeInstanceOf(TestItemError)
    expect(fn).not.toHaveBeenCalled()
  })
  it('rejects a test item a human approves, without running fn', async () => {
    const { f } = fakeFetch([
      { status: 202, body: { id: 'wi1', status: 'pending', test: true } },
      { status: 200, body: { id: 'wi1', status: 'cleared', test: true } },
    ])
    const fn = vi.fn(() => 'ran')
    await expect(client(f).guard({ action: 'refund.create' }, fn)).rejects.toBeInstanceOf(TestItemError)
    expect(fn).not.toHaveBeenCalled()
  })
  it('rejects when only the settled status is flagged test', async () => {
    const { f } = fakeFetch([
      { status: 202, body: { id: 'wi1', status: 'pending' } },
      { status: 200, body: { id: 'wi1', status: 'cleared', test: true } },
    ])
    const fn = vi.fn(() => 'ran')
    await expect(client(f).guard({ action: 'refund.create' }, fn)).rejects.toMatchObject({ name: 'TestItemError', result: { id: 'wi1', test: true } })
    expect(fn).not.toHaveBeenCalled()
  })
})

describe('test items surface on status() and wait() (CLE-221)', () => {
  it('status() and wait() pass test: true through', async () => {
    const { f } = fakeFetch([{ status: 200, body: { id: 'wi1', status: 'cleared', test: true } }])
    expect((await client(f).status('wi1')).test).toBe(true)
    expect((await client(f).wait('wi1', { pollMs: 1 })).test).toBe(true)
  })
})

// CLE-211: idempotency keys ride the Idempotency-Key header on gate + resubmit.
describe('ClearedBy idempotency keys', () => {
  it('gate sends Idempotency-Key when idempotencyKey is set (and not in the body)', async () => {
    const { f, calls } = fakeFetch([{ status: 200, body: { id: 'wi1', status: 'cleared' } }])
    await client(f).gate({ action: 'refund.create', idempotencyKey: 'op-123' })
    expect(calls[0]!.init.headers['idempotency-key']).toBe('op-123')
    expect(JSON.parse(calls[0]!.init.body)).not.toHaveProperty('idempotencyKey')
    expect(JSON.parse(calls[0]!.init.body)).not.toHaveProperty('idempotency_key')
  })
  it('gate omits the header when no key is given', async () => {
    const { f, calls } = fakeFetch([{ status: 200, body: { id: 'wi1', status: 'cleared' } }])
    await client(f).gate({ action: 'refund.create' })
    expect(calls[0]!.init.headers).not.toHaveProperty('idempotency-key')
  })
  it('resubmit links the parent AND sends the key', async () => {
    const { f, calls } = fakeFetch([{ status: 202, body: { id: 'wi2', status: 'pending' } }])
    await client(f).resubmit('wi1', { action: 'refund.create', params: { amount: 40 }, idempotencyKey: 'rev-1' })
    expect(calls[0]!.init.headers['idempotency-key']).toBe('rev-1')
    expect(JSON.parse(calls[0]!.init.body)).toMatchObject({ parent_item_id: 'wi1', action: 'refund.create' })
  })
})

// CLE-211: the API returns { rows, next_cursor } — ledger() used to be typed
// { entries }, so `.entries` was always undefined for real callers.
describe('ClearedBy.ledger', () => {
  it('returns rows + next_cursor from the real API shape, with entries as an alias', async () => {
    const row = { seq: 7, id: 'a1', kind: 'decision', actor: 'policy:auto', work_item_id: 'wi1', payload: {}, prev_hash: 'p', hash: 'h', signature: 's', key_id: 'v1', created_at: '2026-01-01T00:00:00.000Z' }
    const { f, calls } = fakeFetch([{ status: 200, body: { rows: [row], next_cursor: 7 } }])
    const page = await client(f).ledger({ limit: 1, cursor: 9 })
    expect(calls[0]!.url).toBe('https://api.test/v1/ledger?limit=1&cursor=9')
    expect(page.rows).toEqual([row])
    expect(page.next_cursor).toBe(7)
    expect(page.entries).toEqual([row])
  })
  it('next_cursor is null on the last page', async () => {
    const { f } = fakeFetch([{ status: 200, body: { rows: [], next_cursor: null } }])
    const page = await client(f).ledger()
    expect(page.rows).toEqual([])
    expect(page.next_cursor).toBeNull()
  })
})

describe('ClearedBy.complete (CLE-210)', () => {
  it('sends items, delivery_receipt_id and the idempotency key header', async () => {
    const body = { recorded: true, tier: 1, diverged: false, status: 'partial', completion_id: 'job-1', idempotent_replay: false, items: { reported: 1, done: 1, failed: 0, skipped: 0, unknown: 0 } }
    const { f, calls } = fakeFetch([{ status: 200, body }])
    const r = await client(f).complete('wi1', {
      status: 'partial',
      completionId: 'job-1',
      items: [{ key: 'gid://shopify/Product/1', status: 'done', before: [], after: ['bf'] }],
      deliveryReceiptId: '01J0000000000000000000000A',
    })
    expect(r).toEqual(body)
    expect(calls[0]!.url).toBe('https://api.test/v1/gate/wi1/complete')
    expect(calls[0]!.init.headers['idempotency-key']).toBe('job-1')
    expect(JSON.parse(calls[0]!.init.body)).toEqual({
      status: 'partial',
      items: [{ key: 'gid://shopify/Product/1', status: 'done', before: [], after: ['bf'] }],
      delivery_receipt_id: '01J0000000000000000000000A',
    })
  })
  it('surfaces 409 codes (already_completed / not_cleared / completion_conflict)', async () => {
    const { f, calls } = fakeFetch([{ status: 409, body: { error: { message: 'final', code: 'already_completed' } } }])
    await expect(client(f).complete('wi1', { status: 'done' })).rejects.toMatchObject({ status: 409, code: 'already_completed' })
    expect(calls[0]!.init.headers['idempotency-key']).toBeUndefined()
  })
})

describe('ClearedBy.buildUndo / reverts (CLE-210)', () => {
  it('GETs /v1/gate/:id/undo and returns a gate input that gate() submits with reverts', async () => {
    const undo = { action: 'shopify.product.tags.update', params: { store: 'a.myshopify.com', count: 1, changes: [] }, reverts: 'wi1', keys: ['gid://shopify/Product/1'] }
    const { f, calls } = fakeFetch([{ status: 200, body: undo }, { status: 202, body: { id: 'wi2', status: 'pending', reverts: 'wi1' } }])
    const c = client(f)
    const input = await c.buildUndo('wi1')
    expect(calls[0]!.url).toBe('https://api.test/v1/gate/wi1/undo')
    expect(calls[0]!.init.method).toBe('GET')
    expect(input).toEqual(undo)
    await c.gate(input)
    expect(JSON.parse(calls[1]!.init.body)).toMatchObject({ action: 'shopify.product.tags.update', reverts: 'wi1' })
    expect(JSON.parse(calls[1]!.init.body).keys).toBeUndefined()
  })
  it('throws with the server code (e.g. not_reversible)', async () => {
    const { f } = fakeFetch([{ status: 422, body: { error: { message: 'irreversible', code: 'not_reversible' } } }])
    await expect(client(f).buildUndo('wi1')).rejects.toMatchObject({ status: 422, code: 'not_reversible' })
  })
  it('check() forwards reverts so `when: reverts` previews', async () => {
    const { f, calls } = fakeFetch([{ status: 200, body: { dry: true, verdict: 'review', rule: 'r', sampled: false } }])
    await client(f).check({ action: 'x', reverts: 'wi1' })
    expect(JSON.parse(calls[0]!.init.body).reverts).toBe('wi1')
  })
})


describe('ClearedBy.revoke / withdraw (CLE-201)', () => {
  it('revoke POSTs the reason to /v1/gate/:id/revoke with the requester key', async () => {
    const { f, calls } = fakeFetch([{ status: 200, body: { id: 'wi1', status: 'revoked', dispatch: 'cancelled' } }])
    const r = await client(f).revoke('wi1', 'customer cancelled')
    expect(r.status).toBe('revoked')
    expect(calls[0]!.url).toBe('https://api.test/v1/gate/wi1/revoke')
    expect(calls[0]!.init.method).toBe('POST')
    expect(JSON.parse(calls[0]!.init.body)).toEqual({ reason: 'customer cancelled' })
  })
  it('revoke surfaces 409 already_executed as ClearedByError', async () => {
    const { f } = fakeFetch([{ status: 409, body: { error: { code: 'already_executed', message: 'done' } } }])
    const err = await client(f).revoke('wi1', 'too late').catch((e) => e)
    expect(err).toBeInstanceOf(ClearedByError)
    expect(err.code).toBe('already_executed')
  })
  it('withdraw POSTs to /v1/gate/:id/withdraw (reason optional)', async () => {
    const { f, calls } = fakeFetch([{ status: 200, body: { id: 'wi1', status: 'withdrawn' } }])
    const r = await client(f).withdraw('wi1')
    expect(r.status).toBe('withdrawn')
    expect(calls[0]!.url).toBe('https://api.test/v1/gate/wi1/withdraw')
    expect(JSON.parse(calls[0]!.init.body)).toEqual({})
  })
  it('wait() returns on revoked / withdrawn / expired instead of polling to timeout', async () => {
    for (const status of ['revoked', 'withdrawn', 'expired']) {
      const { f } = fakeFetch([{ status: 200, body: { id: 'wi1', status } }])
      const r = await client(f).wait('wi1', { timeoutMs: 50, pollMs: 1 })
      expect(r.status).toBe(status)
    }
  })
})
