// CLE-222: one test per org / partner method added for SDK completeness. Each
// asserts the HTTP method, path (+ query), JSON body and the bearer used.
import { describe, expect, it } from 'vitest'
import { ClearedBy, ClearedByApiError, ClearedByError, ClearedByPartner } from '../src/index'

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

const BASE = 'https://api.test'
const org = (f: typeof fetch) => new ClearedBy({ apiKey: 'cb_live_k', baseUrl: BASE, fetch: f })
const partner = (f: typeof fetch) => new ClearedByPartner({ partnerKey: 'cb_partner_k', baseUrl: `${BASE}/`, fetch: f })

/** Run one call against a single canned response and return what was sent. */
async function sent<T>(
  make: (f: typeof fetch) => Promise<T>,
  response: { status?: number; body?: unknown } = {},
): Promise<{ result: T; url: string; method: string; body: unknown; auth: string; headers: Record<string, string> }> {
  const { f, calls } = fakeFetch([{ status: response.status ?? 200, body: response.body ?? {} }])
  const result = await make(f)
  const c = calls[0]!
  return {
    result,
    url: c.url,
    method: c.init.method,
    body: c.init.body === undefined ? undefined : JSON.parse(c.init.body),
    auth: c.init.headers.authorization,
    headers: c.init.headers,
  }
}

describe('ClearedByApiError', () => {
  it('carries status, code, message, hint and details from the envelope', async () => {
    const { f } = fakeFetch([
      { status: 422, body: { error: { code: 'subject_id_required', message: 'name the subject', hint: 'set context.subject_id', details: { field: 'context.subject_id' } } } },
    ])
    const err = await org(f).gate({ action: 'shopify.refund.create' }).catch((e) => e)
    expect(err).toBeInstanceOf(ClearedByApiError)
    expect(err).toBeInstanceOf(ClearedByError) // the older name is the same class
    expect(err.name).toBe('ClearedByApiError')
    expect(err.status).toBe(422)
    expect(err.code).toBe('subject_id_required')
    expect(err.message).toBe('name the subject')
    expect(err.hint).toBe('set context.subject_id')
    expect(err.details).toEqual({ field: 'context.subject_id' })
  })

  it('puts extra envelope fields in details (410 receipt_redacted)', async () => {
    const { f } = fakeFetch([{ status: 410, body: { error: { code: 'receipt_redacted', message: 'gone', receipt_id: 'r1', receipt_hash: 'h' } } }])
    const err = await org(f).receipt('wi1').catch((e) => e)
    expect(err.code).toBe('receipt_redacted')
    expect(err.details).toEqual({ receipt_id: 'r1', receipt_hash: 'h' })
  })

  it('falls back to a generic message without an envelope', async () => {
    const { f } = fakeFetch([{ status: 502, body: {} }])
    const err = await org(f).usage().catch((e) => e)
    expect(err.message).toBe('usage failed (502)')
    expect(err.code).toBeUndefined()
    expect(err.details).toBeUndefined()
  })
})

describe('ClearedBy (org key): gate fields', () => {
  it('sends on_decision, callback_url, timeout, audience and reverts', async () => {
    const r = await sent((f) =>
      org(f).gate({
        action: 'shopify.refund.create',
        params: { amount: 5 },
        context: { subject_id: 'gid://shopify/Customer/1', batch_id: 'b1', requested_by_subject: 'user_17' },
        audience: 'mcp://x',
        callbackUrl: 'https://cb.example/hook',
        timeout: '1h',
        reverts: 'wi0',
        onDecision: { cleared: { url: 'https://exec.example' }, rejected: { url: 'https://notify.example' } },
        idempotencyKey: 'op-1',
      }),
    )
    expect(r.method).toBe('POST')
    expect(r.url).toBe(`${BASE}/v1/gate`)
    expect(r.auth).toBe('Bearer cb_live_k')
    expect(r.headers['idempotency-key']).toBe('op-1')
    expect(r.body).toEqual({
      action: 'shopify.refund.create',
      params: { amount: 5 },
      context: { subject_id: 'gid://shopify/Customer/1', batch_id: 'b1', requested_by_subject: 'user_17' },
      audience: 'mcp://x',
      callback_url: 'https://cb.example/hook',
      timeout: '1h',
      reverts: 'wi0',
      on_decision: { cleared: { url: 'https://exec.example' }, rejected: { url: 'https://notify.example' } },
    })
  })

  it('accepts the wire-name aliases on_decision / callback_url', async () => {
    const r = await sent((f) =>
      org(f).gate({ action: 'a', callback_url: 'https://cb.example', on_decision: { expired: { url: 'https://n.example' } } }),
    )
    expect(r.body).toMatchObject({ callback_url: 'https://cb.example', on_decision: { expired: { url: 'https://n.example' } } })
  })
})

describe('ClearedBy (org key): new methods', () => {
  it('undo builds the undo then gates it', async () => {
    const { f, calls } = fakeFetch([
      { status: 200, body: { action: 'shopify.tags.set', params: { changes: [] }, reverts: 'wi1', keys: ['k'] } },
      { status: 202, body: { id: 'wi2', status: 'pending' } },
    ])
    const r = await org(f).undo('wi1', { context: { summary: 'undo' } })
    expect(r.id).toBe('wi2')
    expect(calls[0]!.url).toBe(`${BASE}/v1/gate/wi1/undo`)
    expect(calls[0]!.init.method).toBe('GET')
    expect(calls[1]!.url).toBe(`${BASE}/v1/gate`)
    expect(JSON.parse(calls[1]!.init.body)).toEqual({
      action: 'shopify.tags.set',
      params: { changes: [] },
      context: { summary: 'undo' },
      reverts: 'wi1',
    })
  })

  it('delivery', async () => {
    const r = await sent((f) => org(f).delivery('wi 1'), { body: { id: 'wi 1', status: 'cleared', delivery: null, deliveries: [] } })
    expect([r.method, r.url, r.body, r.auth]).toEqual(['GET', `${BASE}/v1/gate/wi%201/delivery`, undefined, 'Bearer cb_live_k'])
    expect(r.result.deliveries).toEqual([])
  })

  it('redeliver', async () => {
    const r = await sent((f) => org(f).redeliver('wi1'), { body: { id: 'wi1', delivery: { delivered: false } } })
    expect([r.method, r.url, r.auth]).toEqual(['POST', `${BASE}/v1/gate/wi1/redeliver`, 'Bearer cb_live_k'])
  })

  it('receipt', async () => {
    const r = await sent((f) => org(f).receipt('wi1'), { body: { receipt_id: 'r1' } })
    expect([r.method, r.url]).toEqual(['GET', `${BASE}/v1/gate/wi1/receipt`])
    expect((r.result as { receipt_id: string }).receipt_id).toBe('r1')
  })

  it('receiptStatus', async () => {
    const r = await sent((f) => org(f).receiptStatus('01J'), { body: { receipt_id: '01J', work_item_id: 'wi1', status: 'revoked' } })
    expect([r.method, r.url]).toEqual(['GET', `${BASE}/v1/receipts/01J/status`])
    expect(r.result.status).toBe('revoked')
  })

  it('events unwraps the list and passes lineage', async () => {
    const r = await sent((f) => org(f).events('wi1', { lineage: true }), { body: { id: 'wi1', events: [{ id: 'e1' }] } })
    expect([r.method, r.url]).toEqual(['GET', `${BASE}/v1/gate/wi1/events?include=lineage`])
    expect(r.result).toEqual([{ id: 'e1' }])
  })

  it('status passes orgId for a partner key', async () => {
    const r = await sent((f) => org(f).status('wi1', { orgId: 'o1' }), { body: { id: 'wi1', status: 'pending' } })
    expect(r.url).toBe(`${BASE}/v1/gate/wi1?org_id=o1`)
  })

  it('list passes reviewerUserId', async () => {
    const r = await sent((f) => org(f).list({ reviewerUserId: 'u1', status: ['pending', 'escalated'] }), { body: { items: [], next_cursor: null } })
    expect(r.url).toBe(`${BASE}/v1/gate?status=pending%2Cescalated&reviewer_user_id=u1`)
  })

  it('verifyLedger', async () => {
    const r = await sent((f) => org(f).verifyLedger(), { body: { intact: true, through: 9, rows: 9 } })
    expect([r.method, r.url]).toEqual(['GET', `${BASE}/v1/ledger/verify`])
    expect(r.result.intact).toBe(true)
  })

  it('listPolicies unwraps', async () => {
    const r = await sent((f) => org(f).listPolicies(), { body: { policies: [{ name: 'p', active_version: 1, latest_version: 2, updated_at: 'x' }] } })
    expect([r.method, r.url]).toEqual(['GET', `${BASE}/v1/policies`])
    expect(r.result[0]!.name).toBe('p')
  })

  it('describePolicy', async () => {
    const r = await sent((f) => org(f).describePolicy('refund rules'), { body: { name: 'refund rules' } })
    expect([r.method, r.url]).toEqual(['GET', `${BASE}/v1/policies/refund%20rules`])
  })

  it('getPolicy', async () => {
    const r = await sent((f) => org(f).getPolicy('p', 3), { body: { name: 'p', version: 3, yaml: 'x' } })
    expect([r.method, r.url]).toEqual(['GET', `${BASE}/v1/policies/p/3`])
  })

  it('savePolicyDraft returns the report on 201 and on a blocked 422', async () => {
    const ok = await sent((f) => org(f).savePolicyDraft('p', 'rules: []'), { status: 201, body: { saved: true, name: 'p', version: 4, lint: [] } })
    expect([ok.method, ok.url, ok.body]).toEqual(['POST', `${BASE}/v1/policies/p`, { yaml: 'rules: []' }])
    expect(ok.result.saved).toBe(true)
    const blocked = await sent((f) => org(f).savePolicyDraft('p', 'bad'), { status: 422, body: { saved: false, name: 'p', lint: [], compile_errors: [{ path: 'rules', message: 'x' }] } })
    expect(blocked.result.saved).toBe(false)
  })

  it('savePolicyDraft throws on other errors', async () => {
    const { f } = fakeFetch([{ status: 400, body: { error: { code: 'invalid_body', message: 'body must be {yaml: string}' } } }])
    await expect(org(f).savePolicyDraft('p', '')).rejects.toBeInstanceOf(ClearedByApiError)
  })

  it('simulatePolicy', async () => {
    const r = await sent((f) => org(f).simulatePolicy('p', 2, { days: 7 }), { body: { total: 0, loosened: [], tightened: [] } })
    expect([r.method, r.url, r.body]).toEqual(['POST', `${BASE}/v1/policies/p/2/simulate`, { days: 7 }])
  })

  it('createWebhook', async () => {
    const input = { url: 'https://hooks.example/cb', events: ['decision.cleared' as const], filters: { action_prefix: 'shopify.' }, source: 'api' as const }
    const r = await sent((f) => org(f).createWebhook(input), { status: 201, body: { id: 'wh1', secret: 's', ...input, active: true } })
    expect([r.method, r.url, r.body, r.auth]).toEqual(['POST', `${BASE}/v1/webhooks`, input, 'Bearer cb_live_k'])
    expect(r.result.secret).toBe('s')
  })

  it('listWebhooks unwraps', async () => {
    const r = await sent((f) => org(f).listWebhooks(), { body: { webhooks: [{ id: 'wh1' }] } })
    expect([r.method, r.url]).toEqual(['GET', `${BASE}/v1/webhooks`])
    expect(r.result).toHaveLength(1)
  })

  it('deleteWebhook', async () => {
    const r = await sent((f) => org(f).deleteWebhook('wh1'), { body: { deleted: true, id: 'wh1' } })
    expect([r.method, r.url, r.body]).toEqual(['DELETE', `${BASE}/v1/webhooks/wh1`, undefined])
  })

  it('signingSecrets', async () => {
    const r = await sent((f) => org(f).signingSecrets(), { body: { org_id: 'o1', on_decision: { secret: 's' }, callback: { secret: 's' } } })
    expect([r.method, r.url]).toEqual(['GET', `${BASE}/v1/signing-secrets`])
    expect(r.result.on_decision.secret).toBe('s')
  })

  it('stats', async () => {
    const r = await sent((f) => org(f).stats({ days: 7 }), { body: { window_days: 7 } })
    expect([r.method, r.url]).toEqual(['GET', `${BASE}/v1/stats?days=7`])
  })

  it('usage', async () => {
    const r = await sent((f) => org(f).usage(), { body: { used: 3 } })
    expect([r.method, r.url]).toEqual(['GET', `${BASE}/v1/usage`])
  })

  it('graduations unwraps', async () => {
    const r = await sent((f) => org(f).graduations({ status: 'all' }), { body: { proposals: [] } })
    expect([r.method, r.url]).toEqual(['GET', `${BASE}/v1/graduation?status=all`])
    expect(r.result).toEqual([])
  })
})

describe('ClearedByPartner: orgs, keys, reviewers', () => {
  it('createOrg (201 with a key, 200 on a repeat)', async () => {
    const input = { external_id: 'shop_1', name: 'Acme', currency: 'GBP', shop_domains: ['acme.myshopify.com'] }
    const r = await sent((f) => partner(f).createOrg(input), { status: 201, body: { org_id: 'o1', created: true, api_key: 'cb_live_x' } })
    expect([r.method, r.url, r.body, r.auth]).toEqual(['POST', `${BASE}/v1/partner/orgs`, input, 'Bearer cb_partner_k'])
    expect(r.result.api_key).toBe('cb_live_x')
    const again = await sent((f) => partner(f).createOrg(input), { status: 200, body: { org_id: 'o1', created: false } })
    expect(again.result.created).toBe(false)
  })

  it('getOrg', async () => {
    const r = await sent((f) => partner(f).getOrg('o1'), { body: { org_id: 'o1' } })
    expect([r.method, r.url, r.auth]).toEqual(['GET', `${BASE}/v1/partner/orgs/o1`, 'Bearer cb_partner_k'])
  })

  it('listOrgs with pagination and filter', async () => {
    const r = await sent((f) => partner(f).listOrgs({ limit: 50, after: 'o9', externalId: 'shop_1' }), { body: { orgs: [], next_after: null } })
    expect([r.method, r.url]).toEqual(['GET', `${BASE}/v1/partner/orgs?limit=50&after=o9&external_id=shop_1`])
  })

  it('iterateOrgs follows next_after', async () => {
    const { f, calls } = fakeFetch([
      { status: 200, body: { orgs: [{ org_id: 'a' }, { org_id: 'b' }], next_after: 'b' } },
      { status: 200, body: { orgs: [{ org_id: 'c' }], next_after: null } },
    ])
    const ids: string[] = []
    for await (const o of partner(f).iterateOrgs({ pageSize: 2 })) ids.push(o.org_id)
    expect(ids).toEqual(['a', 'b', 'c'])
    expect(calls.map((c) => c.url)).toEqual([`${BASE}/v1/partner/orgs?limit=2`, `${BASE}/v1/partner/orgs?limit=2&after=b`])
  })

  it('findOrg', async () => {
    const r = await sent((f) => partner(f).findOrg('shop_1'), { body: { orgs: [], next_after: null } })
    expect(r.url).toBe(`${BASE}/v1/partner/orgs?limit=1&external_id=shop_1`)
    expect(r.result).toBeNull()
  })

  it('updateOrg', async () => {
    const patch = { name: 'Acme Ltd', currency: 'EUR', shop_domains: ['a.myshopify.com'], execution_url: null, notify_url: 'https://n.example', theme: { radius: '4px' } }
    const r = await sent((f) => partner(f).updateOrg('o1', patch), { body: { org_id: 'o1' } })
    expect([r.method, r.url, r.body]).toEqual(['PATCH', `${BASE}/v1/partner/orgs/o1`, patch])
  })

  it('getOrgTheme', async () => {
    const r = await sent((f) => partner(f).getOrgTheme('o1'), { body: { org_id: 'o1', theme: { radius: '4px' } } })
    expect([r.method, r.url]).toEqual(['GET', `${BASE}/v1/partner/orgs/o1/theme`])
    expect(r.result).toEqual({ radius: '4px' })
  })

  it('createOrgKey', async () => {
    const r = await sent((f) => partner(f).createOrgKey('o1', { name: 'executor' }), { status: 201, body: { org_id: 'o1', api_key: 'cb_live_y' } })
    expect([r.method, r.url, r.body]).toEqual(['POST', `${BASE}/v1/partner/orgs/o1/keys`, { name: 'executor' }])
    expect(r.result.api_key).toBe('cb_live_y')
  })

  // CLE-224: key list / revoke / rotate.
  it('listOrgKeys unwraps', async () => {
    const r = await sent((f) => partner(f).listOrgKeys('o1'), { body: { org_id: 'o1', keys: [{ key_id: 'k1', active: true }] } })
    expect([r.method, r.url, r.body, r.auth]).toEqual(['GET', `${BASE}/v1/partner/orgs/o1/keys`, undefined, 'Bearer cb_partner_k'])
    expect(r.result).toEqual([{ key_id: 'k1', active: true }])
  })

  it('revokeOrgKey', async () => {
    const r = await sent((f) => partner(f).revokeOrgKey('o1', 'k/1'), { body: { org_id: 'o1', key_id: 'k/1', active: false } })
    expect([r.method, r.url, r.body]).toEqual(['DELETE', `${BASE}/v1/partner/orgs/o1/keys/k%2F1`, undefined])
    expect(r.result.active).toBe(false)
  })

  it('rotateOrgKey sends grace_seconds (or an empty body)', async () => {
    const body = { org_id: 'o1', key_id: 'k2', api_key: 'cb_live_new', replaced: { key_id: 'k1', revokes_at: 'x' } }
    const r = await sent((f) => partner(f).rotateOrgKey('o1', 'k1', { graceSeconds: 3600 }), { status: 201, body })
    expect([r.method, r.url, r.body]).toEqual(['POST', `${BASE}/v1/partner/orgs/o1/keys/k1/rotate`, { grace_seconds: 3600 }])
    expect(r.result.api_key).toBe('cb_live_new')
    const now = await sent((f) => partner(f).rotateOrgKey('o1', 'k1'), { status: 201, body })
    expect(now.body).toEqual({})
    await expect(sent((f) => partner(f).rotateOrgKey('o1', 'k1'), { status: 409, body: { error: { code: 'key_revoked', message: 'm' } } }))
      .rejects.toMatchObject({ status: 409, code: 'key_revoked' })
  })

  // CLE-224: webhooks with the partner key, scoped by ?org_id=.
  it('createWebhook / listWebhooks / deleteWebhook pass org_id', async () => {
    const input = { url: 'https://hooks.example/cb', events: ['decision.cleared' as const] }
    const c = await sent((f) => partner(f).createWebhook('o1', input), { status: 201, body: { id: 'w1', secret: 'whsec_x' } })
    expect([c.method, c.url, c.body, c.auth]).toEqual(['POST', `${BASE}/v1/webhooks?org_id=o1`, input, 'Bearer cb_partner_k'])
    expect(c.result.secret).toBe('whsec_x')
    const l = await sent((f) => partner(f).listWebhooks('o1'), { body: { webhooks: [{ id: 'w1' }] } })
    expect([l.method, l.url]).toEqual(['GET', `${BASE}/v1/webhooks?org_id=o1`])
    expect(l.result).toEqual([{ id: 'w1' }])
    const d = await sent((f) => partner(f).deleteWebhook('o1', 'w1'), { body: { deleted: true, id: 'w1' } })
    expect([d.method, d.url]).toEqual(['DELETE', `${BASE}/v1/webhooks/w1?org_id=o1`])
  })

  it('upsertReviewer reports created from the status', async () => {
    const input = { display_name: 'Sam', role: 'reviewer' as const, authority: { 'shopify.refund.create': 50000 } }
    const r = await sent((f) => partner(f).upsertReviewer('o1', 'user@17', input), { status: 201, body: { external_subject: 'user@17', active: true } })
    expect([r.method, r.url, r.body]).toEqual(['PUT', `${BASE}/v1/partner/orgs/o1/reviewers/user%4017`, input])
    expect(r.result.created).toBe(true)
    const upd = await sent((f) => partner(f).upsertReviewer('o1', 'u', input), { status: 200, body: { external_subject: 'u' } })
    expect(upd.result.created).toBe(false)
  })

  it('removeReviewer', async () => {
    const r = await sent((f) => partner(f).removeReviewer('o1', 'u1'), { body: { external_subject: 'u1', active: false } })
    expect([r.method, r.url, r.body]).toEqual(['DELETE', `${BASE}/v1/partner/orgs/o1/reviewers/u1`, undefined])
    expect(r.result.active).toBe(false)
  })

  it('listReviewers unwraps', async () => {
    const r = await sent((f) => partner(f).listReviewers('o1'), { body: { org_id: 'o1', reviewers: [{ external_subject: 'u1' }] } })
    expect([r.method, r.url]).toEqual(['GET', `${BASE}/v1/partner/orgs/o1/reviewers`])
    expect(r.result[0]!.external_subject).toBe('u1')
  })
})

describe('ClearedByPartner: erasure, tokens, reads, policies', () => {
  it('eraseSubject puts the subject in the body, not the URL', async () => {
    const r = await sent((f) => partner(f).eraseSubject('o1', 'gid://shopify/Customer/7'), { body: { items_redacted: 2 } })
    expect([r.method, r.url, r.body]).toEqual(['POST', `${BASE}/v1/partner/orgs/o1/erasure`, { subject_id: 'gid://shopify/Customer/7' }])
  })

  it('eraseSubjectEverywhere', async () => {
    const r = await sent((f) => partner(f).eraseSubjectEverywhere('gid://shopify/Customer/7'), { body: { complete: true } })
    expect([r.method, r.url, r.body, r.auth]).toEqual(['POST', `${BASE}/v1/partner/erasure`, { subject_id: 'gid://shopify/Customer/7' }, 'Bearer cb_partner_k'])
  })

  it('createReadToken asks for scope read', async () => {
    const r = await sent((f) => partner(f).createReadToken({ orgId: 'o1', externalSubject: 'u1', ttlSeconds: 600 }), { status: 201, body: { token: 'cb_dt_r' } })
    expect([r.method, r.url, r.body]).toEqual(['POST', `${BASE}/v1/auth/decision-token`, { org_id: 'o1', external_subject: 'u1', ttl_seconds: 600, scope: 'read' }])
  })

  it('list with the partner key sends org_id', async () => {
    const r = await sent((f) => partner(f).list('o1', { status: 'pending', reviewer: 'u1', limit: 10 }), { body: { items: [], next_cursor: null } })
    expect([r.method, r.url, r.auth]).toEqual(['GET', `${BASE}/v1/gate?status=pending&reviewer=u1&limit=10&org_id=o1`, 'Bearer cb_partner_k'])
  })

  it('list with a reviewer token reads as that reviewer', async () => {
    const r = await sent((f) => partner(f).list('o1', { token: 'cb_dt_r' }), { body: { items: [], next_cursor: null } })
    expect(r.auth).toBe('Bearer cb_dt_r')
  })

  it('get', async () => {
    const r = await sent((f) => partner(f).get('o1', 'wi1', { include: ['events'] }), { body: { id: 'wi1' } })
    expect([r.method, r.url, r.auth]).toEqual(['GET', `${BASE}/v1/gate/wi1/detail?include=events&org_id=o1`, 'Bearer cb_partner_k'])
  })

  it('status', async () => {
    const r = await sent((f) => partner(f).status('o1', 'wi1'), { body: { id: 'wi1', status: 'pending' } })
    expect([r.method, r.url]).toEqual(['GET', `${BASE}/v1/gate/wi1?org_id=o1`])
  })

  it('events', async () => {
    const r = await sent((f) => partner(f).events('o1', 'wi1', { lineage: true }), { body: { id: 'wi1', events: [] } })
    expect([r.method, r.url]).toEqual(['GET', `${BASE}/v1/gate/wi1/events?include=lineage&org_id=o1`])
    expect(r.result).toEqual([])
  })

  it('permissions', async () => {
    const r = await sent((f) => partner(f).permissions('o1', 'wi1', 'u1'), { body: { can: ['clear'] } })
    expect([r.method, r.url]).toEqual(['GET', `${BASE}/v1/gate/wi1/permissions?reviewer=u1&org_id=o1`])
  })

  it('activatePolicy with the partner key sends org_id in the body', async () => {
    const r = await sent((f) => partner(f).activatePolicy('o1', 'shopify-rules', 3), { body: { activated: { name: 'shopify-rules', version: 3 } } })
    expect([r.method, r.url, r.body, r.auth]).toEqual(['POST', `${BASE}/v1/policies/shopify-rules/3/activate`, { org_id: 'o1' }, 'Bearer cb_partner_k'])
  })

  it('activatePolicy with an owner token sends no body', async () => {
    const r = await sent((f) => partner(f).activatePolicy('o1', 'p', 2, { token: 'cb_dt_owner' }), { body: {} })
    expect([r.body, r.auth]).toEqual([undefined, 'Bearer cb_dt_owner'])
  })

  it('getSigningSecrets returns the full view', async () => {
    const r = await sent((f) => partner(f).getSigningSecrets('o1'), { body: { org_id: 'o1', on_decision: { secret: 's1' }, callback: { secret: 's1' } } })
    expect([r.method, r.url]).toEqual(['GET', `${BASE}/v1/signing-secrets?org_id=o1`])
    expect(r.result.callback.secret).toBe('s1')
  })

  it('setRules accepts spot_checks / spot_check_pct', async () => {
    const r = await sent((f) => partner(f).setRules('o1', { spot_checks: true, spot_check_pct: 10 }), { status: 200, body: { status: 'active' } })
    expect([r.method, r.url, r.body]).toEqual(['PUT', `${BASE}/v1/partner/orgs/o1/rules`, { settings: { spot_checks: true, spot_check_pct: 10 } }])
  })
})
