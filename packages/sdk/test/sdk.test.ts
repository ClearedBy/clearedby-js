import { describe, expect, it, vi } from 'vitest'
import { ClearedBy, RejectedError, ClearedByError } from '../src/index'

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
})
