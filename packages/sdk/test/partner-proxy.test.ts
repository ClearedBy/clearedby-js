import { describe, expect, it, vi } from 'vitest'
import { createPartnerProxy, expressHandler, type ProxyUser } from '../src/partner-proxy'

const PARTNER_KEY = 'cb_partner_0123456789abcdef0123456789abcdef'
const ALICE: ProxyUser = { org_id: 'org_A', external_subject: 'alice' }

interface Call {
  method: string
  url: string
  auth: string
  body: any
}

/** A fake ClearedBy: records every call and answers the few endpoints the proxy uses. */
function fakeApi(overrides: Record<string, (call: Call) => { status: number; body: unknown }> = {}) {
  const calls: Call[] = []
  let n = 0
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const headers = new Headers(init?.headers)
    const call: Call = {
      method: init?.method ?? 'GET',
      url,
      auth: headers.get('authorization') ?? '',
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    }
    calls.push(call)
    const path = new URL(url).pathname
    const key = `${call.method} ${path}`
    const hit = Object.entries(overrides).find(([k]) => new RegExp(`^${k}$`).test(key))
    const reply = hit !== undefined
      ? hit[1](call)
      : path === '/v1/auth/decision-token'
        ? { status: 201, body: { token: `cb_dt_${String(++n).padStart(48, '0')}`, token_id: `t${n}`, scope: call.body.scope ?? 'decide' } }
        : path.endsWith('/decide')
          ? { status: 200, body: { status: 'cleared', attestation: { seq: 1, hash: 'h' }, receipt: { receipt_id: 'r1', sig: 'x' } } }
          : path.endsWith('/reviewers')
            ? { status: 200, body: { reviewers: [{ external_subject: 'alice', role: 'owner', active: true, email: 'a@x.com' }, { external_subject: 'bob', role: 'reviewer', active: true }] } }
            : { status: 200, body: { ok: true, path } }
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } })
  })
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls }
}

const body = (r: Response): Promise<any> => r.json()

const mk = (api: ReturnType<typeof fakeApi>, resolveUser: (req: Request) => ProxyUser | null = () => ALICE, extra = {}) =>
  createPartnerProxy({ partnerKey: PARTNER_KEY, baseUrl: 'https://cb.test', fetch: api.fetch, resolveUser, ...extra })

const get = (path: string, headers: Record<string, string> = {}) => new Request(`https://partner.test/api/clearedby${path}`, { headers })
const post = (path: string, body: unknown, headers: Record<string, string> = {}, method = 'POST') =>
  new Request(`https://partner.test/api/clearedby${path}`, {
    method,
    headers: { 'content-type': 'application/json', origin: 'https://partner.test', host: 'partner.test', ...headers },
    body: JSON.stringify(body),
  })

describe('partner proxy', () => {
  it('401s when resolveUser returns null (and never calls ClearedBy)', async () => {
    const api = fakeApi()
    const proxy = mk(api, () => null)
    const res = await proxy.handle(get('/items'))
    expect(res.status).toBe(401)
    expect(api.calls).toHaveLength(0)
    // A throwing resolver is also just "not signed in".
    const throwing = mk(api, () => { throw new Error('boom') })
    expect((await throwing.handle(get('/items'))).status).toBe(401)
  })

  it('only serves the allow-listed routes: anything else is 404/405 and nothing is forwarded', async () => {
    const api = fakeApi()
    const proxy = mk(api)
    for (const path of ['/v1/gate', '/partner/orgs', '/items/abc/evidence', '/../v1/ledger', '/items/a%2Fb', '/rules/x', '/orgs/org_A/reviewers', '']) {
      const res = await proxy.handle(get(path))
      expect([404, 405]).toContain(res.status)
    }
    expect((await proxy.handle(new Request('https://partner.test/other/items'))).status).toBe(404)
    expect((await proxy.handle(post('/items', {}))).status).toBe(405)
    expect((await proxy.handle(get('/items/abc/decide'))).status).toBe(405)
    expect(api.calls).toHaveLength(0)
  })

  it('reads with a read token minted for the resolved user; org_id and reviewer from the client are ignored', async () => {
    const api = fakeApi()
    const proxy = mk(api)
    const res = await proxy.handle(get('/items?status=pending,escalated&org_id=org_EVIL&reviewer=bob&include=params,context&limit=20'))
    expect(res.status).toBe(200)
    const [mint, list] = api.calls
    expect(mint!.url).toBe('https://cb.test/v1/auth/decision-token')
    expect(mint!.auth).toBe(`Bearer ${PARTNER_KEY}`)
    expect(mint!.body).toMatchObject({ org_id: 'org_A', external_subject: 'alice', scope: 'read' })
    const u = new URL(list!.url)
    expect(u.pathname).toBe('/v1/gate')
    expect(u.searchParams.get('org_id')).toBeNull()
    expect(u.searchParams.get('reviewer')).toBeNull()
    expect(u.searchParams.get('status')).toBe('pending,escalated')
    expect(u.searchParams.get('include')).toBe('params') // context isn't allow-listed
    expect(u.searchParams.get('limit')).toBe('20')
    expect(list!.auth).toMatch(/^Bearer cb_dt_/)
  })

  it('caches the read token per person and re-mints after a 401', async () => {
    let expired = false
    const api = fakeApi({
      'GET /v1/gate/[^/]+/detail': (c) => (expired && c.auth.endsWith('1') ? { status: 401, body: { error: { code: 'invalid_token', message: 'expired' } } } : { status: 200, body: { id: 'i1' } }),
    })
    const proxy = mk(api)
    await proxy.handle(get('/items/i1'))
    await proxy.handle(get('/items/i1/permissions'))
    await proxy.handle(get('/items/i1/events'))
    expect(api.calls.filter((c) => c.url.endsWith('/decision-token'))).toHaveLength(1)
    expect(api.calls.find((c) => c.url.includes('/events'))!.url).toContain('include=lineage')
    expired = true
    const res = await proxy.handle(get('/items/i1'))
    expect(res.status).toBe(200)
    expect(api.calls.filter((c) => c.url.endsWith('/decision-token'))).toHaveLength(2)
  })

  it('a different user gets a different token and their own org', async () => {
    const api = fakeApi()
    let who: ProxyUser = ALICE
    const proxy = mk(api, () => who)
    await proxy.handle(get('/items'))
    who = { org_id: 'org_B', external_subject: 'xavier' }
    await proxy.handle(get('/items'))
    const mints = api.calls.filter((c) => c.url.endsWith('/decision-token'))
    expect(mints.map((m) => m.body.org_id)).toEqual(['org_A', 'org_B'])
  })

  it('decides with a fresh single-use token pinned to the item, and returns no tokens or receipts', async () => {
    const api = fakeApi()
    const proxy = mk(api)
    const res = await proxy.handle(post('/items/01KITEM/decide', { decision: 'clear' }))
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).not.toMatch(/cb_(dt|partner|live)_/)
    expect(JSON.parse(text)).toEqual({ status: 'cleared', attestation: { seq: 1, hash: 'h' } })
    const mint = api.calls[0]!
    expect(mint.body).toMatchObject({ org_id: 'org_A', external_subject: 'alice', work_item_id: '01KITEM' })
    expect(mint.body.scope).toBeUndefined()
    const decide = api.calls[1]!
    expect(decide.url).toBe('https://cb.test/v1/gate/01KITEM/decide')
    expect(decide.auth).toMatch(/^Bearer cb_dt_/)
    expect(decide.body).toEqual({ decision: 'clear' })
  })

  it('requires a reason for decline and send back, and validates the body', async () => {
    const api = fakeApi()
    const proxy = mk(api)
    for (const decision of ['reject', 'send_back']) {
      const res = await proxy.handle(post('/items/i1/decide', { decision }))
      expect(res.status).toBe(400)
      expect((await body(res)).error.code).toBe('reason_required')
      expect((await proxy.handle(post('/items/i1/decide', { decision, reason: 'no' }))).status).toBe(400)
    }
    expect((await proxy.handle(post('/items/i1/decide', { decision: 'approve' }))).status).toBe(400)
    expect((await proxy.handle(post('/items/i1/decide', { decision: 'clear', org_id: 'org_EVIL' }))).status).toBe(400)
    expect((await proxy.handle(post('/items/i1/decide', { decision: 'clear', escalate_to: 'bob' }))).status).toBe(400)
    expect(api.calls).toHaveLength(0)
    const ok = await proxy.handle(post('/items/i1/decide', { decision: 'escalate', escalate_to: 'bob', reason: 'over my limit' }))
    expect(ok.status).toBe(200)
    expect(api.calls[1]!.body).toEqual({ decision: 'escalate', escalate_to: 'bob', reason: 'over my limit' })
  })

  it('refuses cross-site writes and non-JSON writes', async () => {
    const api = fakeApi()
    const proxy = mk(api)
    expect((await proxy.handle(post('/items/i1/decide', { decision: 'clear' }, { origin: 'https://evil.test' }))).status).toBe(403)
    const form = new Request('https://partner.test/api/clearedby/items/i1/decide', {
      method: 'POST',
      headers: { 'content-type': 'text/plain', origin: 'https://partner.test', host: 'partner.test' },
      body: '{"decision":"clear"}',
    })
    expect((await proxy.handle(form)).status).toBe(415)
    expect(api.calls).toHaveLength(0)
    const allowed = mk(api, () => ALICE, { allowedOrigins: ['https://admin.partner.test'] })
    expect((await allowed.handle(post('/items/i1/decide', { decision: 'clear' }, { origin: 'https://admin.partner.test' }))).status).toBe(200)
  })

  it('passes ClearedBy refusals through as code + message only', async () => {
    const api = fakeApi({
      'POST /v1/gate/[^/]+/decide': () => ({ status: 403, body: { error: { code: 'no_authority', message: 'your authority does not cover this', hint: 'POST /v1/auth/decision-token ...' } } }),
    })
    const res = await mk(api).handle(post('/items/i1/decide', { decision: 'clear' }))
    expect(res.status).toBe(403)
    expect(await body(res)).toEqual({ error: { code: 'no_authority', message: 'your authority does not cover this' } })
  })

  it('never leaks the partner key: a refused partner key becomes a 502', async () => {
    const api = fakeApi({
      'POST /v1/auth/decision-token': () => ({ status: 401, body: { error: { code: 'unauthorized', message: `unknown partner key ${PARTNER_KEY}` } } }),
    })
    const res = await mk(api).handle(get('/items'))
    expect(res.status).toBe(502)
    expect(await res.text()).not.toContain('cb_partner_')
  })

  it('an unknown person gets 403 not_a_reviewer', async () => {
    const api = fakeApi({ 'POST /v1/auth/decision-token': () => ({ status: 404, body: { error: { code: 'not_found', message: 'no such reviewer' } } }) })
    const res = await mk(api).handle(get('/items'))
    expect(res.status).toBe(403)
    expect((await body(res)).error.code).toBe('not_a_reviewer')
  })

  it('revokes as the person (pinned decide token) with a required reason', async () => {
    const api = fakeApi()
    const proxy = mk(api)
    expect((await proxy.handle(post('/items/i1/revoke', {}))).status).toBe(400)
    const res = await proxy.handle(post('/items/i1/revoke', { reason: 'customer cancelled' }))
    expect(res.status).toBe(200)
    expect(api.calls[0]!.body.work_item_id).toBe('i1')
    expect(api.calls[1]!.url).toBe('https://cb.test/v1/gate/i1/revoke')
    expect(api.calls[1]!.url).not.toContain('org_id')
  })

  it('rules: GET adds the viewer role only; PUT uses the resolved org; accept uses an unpinned decide token', async () => {
    const api = fakeApi({
      'GET /v1/partner/orgs/[^/]+/rules': () => ({ status: 200, body: { settings: { refund_auto_max: 25 }, summary: [] } }),
      'PUT /v1/partner/orgs/[^/]+/rules': () => ({ status: 202, body: { status: 'needs_owner_approval', proposal_id: 'p1', summary_diff: [] } }),
      'POST /v1/partner/orgs/[^/]+/rules/[^/]+/accept': () => ({ status: 200, body: { status: 'active' } }),
    })
    const proxy = mk(api)
    const rules = await body(await proxy.handle(get('/rules')))
    expect(rules.viewer).toEqual({ role: 'owner', can_edit: true, can_accept: true })
    expect(JSON.stringify(rules)).not.toContain('a@x.com')

    const put = await proxy.handle(post('/rules', { settings: { refund_auto_max: 50 } }, {}, 'PUT'))
    expect(put.status).toBe(202)
    const putCall = api.calls.find((c) => c.method === 'PUT')!
    expect(putCall.url).toBe('https://cb.test/v1/partner/orgs/org_A/rules')
    expect(putCall.auth).toBe(`Bearer ${PARTNER_KEY}`)
    expect((await proxy.handle(post('/rules', { settings: {}, org_id: 'org_EVIL' }, {}, 'PUT'))).status).toBe(400)

    const acc = await proxy.handle(post('/rules/proposals/p1/accept', {}))
    expect(acc.status).toBe(200)
    const mint = api.calls.filter((c) => c.url.endsWith('/decision-token')).at(-1)!
    expect(mint.body.work_item_id).toBeUndefined()
    expect(mint.body.org_id).toBe('org_A')
    expect(api.calls.at(-1)!.url).toBe('https://cb.test/v1/partner/orgs/org_A/rules/p1/accept')
    expect(api.calls.at(-1)!.auth).toMatch(/^Bearer cb_dt_/)
  })

  it('GET /theme returns only the resolved org’s theme (cached), with the partner key server-side', async () => {
    const api = fakeApi({
      'GET /v1/partner/orgs/[^/]+/theme': (c) => ({ status: 200, body: { org_id: new URL(c.url).pathname.split('/')[4], theme: { colors: { primary: '#6b3fd4' } } } }),
    })
    const proxy = mk(api)
    const res = await proxy.handle(get('/theme?org_id=org_EVIL'))
    expect(res.status).toBe(200)
    expect(await body(res)).toEqual({ theme: { colors: { primary: '#6b3fd4' } } })
    expect(api.calls[0]!.url).toBe('https://cb.test/v1/partner/orgs/org_A/theme')
    expect(api.calls[0]!.auth).toBe(`Bearer ${PARTNER_KEY}`)
    await proxy.handle(get('/theme'))
    expect(api.calls).toHaveLength(1)
    expect((await proxy.handle(post('/theme', {}))).status).toBe(405)
  })

  it('canEditRules can hide rule editing', async () => {
    const api = fakeApi({ 'GET /v1/partner/orgs/[^/]+/rules': () => ({ status: 200, body: { settings: null, summary: [] } }) })
    const proxy = mk(api, () => ALICE, { canEditRules: () => false })
    expect((await body(await proxy.handle(get('/rules')))).viewer.can_edit).toBe(false)
    expect((await proxy.handle(post('/rules', { settings: { refund_auto_max: 1 } }, {}, 'PUT'))).status).toBe(403)
  })

  it('no response ever contains a ClearedBy credential', async () => {
    const api = fakeApi({
      'GET /v1/gate/[^/]+/detail': () => ({ status: 200, body: { id: 'i1', note: 'cb_live_abcdef123456', receipt: { r: 1 } } }),
    })
    const proxy = mk(api)
    for (const r of [get('/items'), get('/items/i1'), get('/items/i1/events'), get('/items/i1/permissions'), get('/rules')]) {
      expect(await (await proxy.handle(r)).text()).not.toMatch(/cb_(dt|partner|live)_[0-9a-z]/)
    }
  })

  it('express adapter maps req/res', async () => {
    const api = fakeApi()
    const handler = expressHandler(mk(api))
    const out: { status?: number; headers: Record<string, string>; body?: string } = { headers: {} }
    const res = {
      status(code: number) { out.status = code; return res },
      setHeader(n: string, v: string) { out.headers[n] = v },
      send(b: string) { out.body = b },
    }
    await handler(
      { method: 'POST', originalUrl: '/api/clearedby/items/i1/decide', url: '/items/i1/decide', protocol: 'https', headers: { host: 'partner.test', origin: 'https://partner.test', 'content-type': 'application/json' }, body: { decision: 'clear' } },
      res,
    )
    expect(out.status).toBe(200)
    expect(JSON.parse(out.body!).status).toBe('cleared')
    expect(out.headers['content-type']).toContain('application/json')
  })
})
