// CLE-208: the read API methods — list(), get(), permissions().
import { describe, expect, it } from 'vitest'
import { ClearedBy, ClearedByError } from '../src/index'

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

const client = (f: typeof fetch, apiKey = 'cb_live_test') => new ClearedBy({ apiKey, baseUrl: 'https://api.test', fetch: f })

describe('ClearedBy.list', () => {
  it('GETs /v1/gate with no query by default', async () => {
    const { f, calls } = fakeFetch([{ status: 200, body: { items: [], next_cursor: null } }])
    const page = await client(f).list()
    expect(page).toEqual({ items: [], next_cursor: null })
    expect(calls[0]!.url).toBe('https://api.test/v1/gate')
    expect(calls[0]!.init.method).toBe('GET')
  })
  it('encodes every filter', async () => {
    const { f, calls } = fakeFetch([{ status: 200, body: { items: [], next_cursor: null } }])
    await client(f, 'cb_partner_x').list({
      status: ['pending', 'escalated'],
      reviewer: 'user_17',
      actionPrefix: 'refund.',
      batchId: 'b1',
      cursor: 'abc',
      limit: 10,
      include: ['params', 'proof'],
      orgId: 'org1',
    })
    const url = new URL(calls[0]!.url)
    expect(url.pathname).toBe('/v1/gate')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      status: 'pending,escalated',
      reviewer: 'user_17',
      action_prefix: 'refund.',
      batch_id: 'b1',
      cursor: 'abc',
      limit: '10',
      include: 'params,proof',
      org_id: 'org1',
    })
    expect(calls[0]!.init.headers.authorization).toBe('Bearer cb_partner_x')
  })
  it('throws ClearedByError on an error envelope', async () => {
    const { f } = fakeFetch([{ status: 400, body: { error: { code: 'invalid_query', message: 'bad' } } }])
    const err = await client(f).list({ limit: 0 }).catch((e) => e)
    expect(err).toBeInstanceOf(ClearedByError)
    expect(err.code).toBe('invalid_query')
  })
})

describe('ClearedBy.get', () => {
  it('GETs the detail path, with include + org_id', async () => {
    const { f, calls } = fakeFetch([{ status: 200, body: { id: 'wi 1', status: 'pending', params: { amount: 9 } } }])
    const c = await client(f).get('wi 1', { include: ['events'], orgId: 'o' })
    expect(c.params).toEqual({ amount: 9 })
    expect(calls[0]!.url).toBe('https://api.test/v1/gate/wi%201/detail?include=events&org_id=o')
  })
  it('404 → ClearedByError', async () => {
    const { f } = fakeFetch([{ status: 404, body: { error: { code: 'not_found', message: 'no such work item' } } }])
    await expect(client(f).get('x')).rejects.toBeInstanceOf(ClearedByError)
  })
  it('status() still hits the plain status path', async () => {
    const { f, calls } = fakeFetch([{ status: 200, body: { id: 'wi1', status: 'cleared' } }])
    await client(f).status('wi1')
    expect(calls[0]!.url).toBe('https://api.test/v1/gate/wi1')
  })
})

describe('ClearedBy.permissions', () => {
  it('GETs permissions for a reviewer', async () => {
    const body = { id: 'wi1', status: 'pending', can: ['escalate'], cannot: [{ decision: 'clear', status: 403, code: 'no_authority', message: 'x' }] }
    const { f, calls } = fakeFetch([{ status: 200, body }])
    const p = await client(f).permissions('wi1', 'user 17')
    expect(p.can).toEqual(['escalate'])
    expect(calls[0]!.url).toBe('https://api.test/v1/gate/wi1/permissions?reviewer=user%2017')
  })
})
