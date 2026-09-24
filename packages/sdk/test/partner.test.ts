import { describe, expect, it } from 'vitest'
import { ClearedByError, ClearedByPartner } from '../src/index'

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

const partner = (f: typeof fetch) =>
  new ClearedByPartner({ partnerKey: 'cb_partner_test', baseUrl: 'https://api.test/', fetch: f })

describe('ClearedByPartner (CLE-207)', () => {
  it('createDecisionToken posts the partner key + snake_case body', async () => {
    const { f, calls } = fakeFetch([{ status: 201, body: { token: 'cb_dt_x', expires_at: '2026-09-23T10:00:00Z' } }])
    const t = await partner(f).createDecisionToken({ orgId: 'org1', externalSubject: 'user-1', workItemId: 'wi1', ttlSeconds: 60 })
    expect(t.token).toBe('cb_dt_x')
    expect(calls[0]!.url).toBe('https://api.test/v1/auth/decision-token')
    expect(calls[0]!.init.headers.authorization).toBe('Bearer cb_partner_test')
    expect(JSON.parse(calls[0]!.init.body)).toEqual({ org_id: 'org1', external_subject: 'user-1', work_item_id: 'wi1', ttl_seconds: 60 })
  })

  it('decide authenticates with the decision token, not the partner key', async () => {
    const { f, calls } = fakeFetch([{ status: 200, body: { status: 'escalated' } }])
    const r = await partner(f).decide('wi 1', { decision: 'escalate', reason: 'too big', escalateTo: 'boss' }, { token: 'cb_dt_y' })
    expect(r.status).toBe('escalated')
    expect(calls[0]!.url).toBe('https://api.test/v1/gate/wi%201/decide')
    expect(calls[0]!.init.headers.authorization).toBe('Bearer cb_dt_y')
    expect(JSON.parse(calls[0]!.init.body)).toEqual({ decision: 'escalate', reason: 'too big', escalate_to: 'boss' })
  })

  it('throws ClearedByError with the API error code', async () => {
    const { f } = fakeFetch([{ status: 403, body: { error: { code: 'no_authority', message: 'nope' } } }])
    const err = await partner(f).decide('wi1', { decision: 'clear' }, { token: 'cb_dt_z' }).catch((e) => e)
    expect(err).toBeInstanceOf(ClearedByError)
    expect(err.status).toBe(403)
    expect(err.code).toBe('no_authority')
  })

  it('requires a partner key', () => {
    expect(() => new ClearedByPartner({ partnerKey: '' })).toThrow(/partnerKey/)
  })

  it('getRules / setRules / acceptRules (CLE-216)', async () => {
    const { f, calls } = fakeFetch([
      { status: 200, body: { settings: null, summary: [], active_version: 1 } },
      { status: 202, body: { status: 'needs_owner_approval', proposal_id: 'p1', summary_diff: [] } },
      { status: 200, body: { status: 'active', active_version: 3 } },
    ])
    const p = partner(f)
    expect((await p.getRules('org 1')).active_version).toBe(1)
    expect(calls[0]!.url).toBe('https://api.test/v1/partner/orgs/org%201/rules')
    expect(calls[0]!.init.method).toBe('GET')
    expect(calls[0]!.init.body).toBeUndefined()

    const set = await p.setRules('org1', { refund_auto_max: 50 })
    expect(set.status).toBe('needs_owner_approval')
    expect(calls[1]!.init.method).toBe('PUT')
    expect(calls[1]!.init.headers.authorization).toBe('Bearer cb_partner_test')
    expect(JSON.parse(calls[1]!.init.body)).toEqual({ settings: { refund_auto_max: 50 } })

    const acc = await p.acceptRules('org1', 'p1', { token: 'cb_dt_owner' })
    expect(acc.active_version).toBe(3)
    expect(calls[2]!.url).toBe('https://api.test/v1/partner/orgs/org1/rules/p1/accept')
    expect(calls[2]!.init.headers.authorization).toBe('Bearer cb_dt_owner')
  })

  it('acceptRules surfaces owner_approval errors', async () => {
    const { f } = fakeFetch([{ status: 403, body: { error: { code: 'forbidden', message: 'owner or admin' } } }])
    const err = await partner(f).acceptRules('o', 'p', { token: 'cb_dt_r' }).catch((e) => e)
    expect(err).toBeInstanceOf(ClearedByError)
    expect(err.code).toBe('forbidden')
  })
})

describe('ClearedByPartner.attachEvidence (CLE-204)', () => {
  it('posts the items with the partner key and org_id', async () => {
    const item = { id: 'e1', type: 'order_lookup', value: { total: 50 }, provenance: 'partner_verified', verified_by: 'partner:p1', verifier_name: 'Intersession', verified_at: '2026-09-24T10:00:00Z', sha256: 'ab' }
    const { f, calls } = fakeFetch([{ status: 201, body: { work_item_id: 'wi 1', items: [item], attestation: { seq: 9, hash: 'h' } } }])
    const r = await partner(f).attachEvidence('org 1', 'wi 1', [{ type: 'order_lookup', value: { total: 50 }, source_ref: 'gid://shopify/Order/1' }])
    expect(r.items[0]!.provenance).toBe('partner_verified')
    expect(r.attestation?.seq).toBe(9)
    expect(calls[0]!.url).toBe('https://api.test/v1/gate/wi%201/evidence?org_id=org%201')
    expect(calls[0]!.init.method).toBe('POST')
    expect(calls[0]!.init.headers.authorization).toBe('Bearer cb_partner_test')
    expect(JSON.parse(calls[0]!.init.body)).toEqual({ items: [{ type: 'order_lookup', value: { total: 50 }, source_ref: 'gid://shopify/Order/1' }] })
  })

  it('throws ClearedByError on a refusal', async () => {
    const { f } = fakeFetch([{ status: 409, body: { error: { code: 'not_pending', message: 'decided' } } }])
    const err = await partner(f).attachEvidence('o', 'wi', [{ type: 'x', value: 1 }]).catch((e) => e)
    expect(err).toBeInstanceOf(ClearedByError)
    expect(err.status).toBe(409)
    expect(err.code).toBe('not_pending')
  })
})

describe('ClearedByPartner.revoke / withdraw (CLE-201)', () => {
  it('revoke with the partner key passes org_id', async () => {
    const { f, calls } = fakeFetch([{ status: 200, body: { id: 'wi1', status: 'revoked' } }])
    await partner(f).revoke('org1', 'wi1', 'merchant cancelled')
    expect(calls[0]!.url).toBe('https://api.test/v1/gate/wi1/revoke?org_id=org1')
    expect(calls[0]!.init.headers.authorization).toBe('Bearer cb_partner_test')
    expect(JSON.parse(calls[0]!.init.body)).toEqual({ reason: 'merchant cancelled' })
  })
  it('revoke as a named reviewer uses their decision token', async () => {
    const { f, calls } = fakeFetch([{ status: 200, body: { id: 'wi1', status: 'revoked' } }])
    await partner(f).revoke('org1', 'wi1', 'wrong order', { token: 'cb_dt_rev' })
    expect(calls[0]!.url).toBe('https://api.test/v1/gate/wi1/revoke')
    expect(calls[0]!.init.headers.authorization).toBe('Bearer cb_dt_rev')
  })
  it('withdraw uses the partner key + org_id', async () => {
    const { f, calls } = fakeFetch([{ status: 200, body: { id: 'wi1', status: 'withdrawn' } }])
    const r = await partner(f).withdraw('org1', 'wi1', 'not needed')
    expect(r.status).toBe('withdrawn')
    expect(calls[0]!.url).toBe('https://api.test/v1/gate/wi1/withdraw?org_id=org1')
    expect(JSON.parse(calls[0]!.init.body)).toEqual({ reason: 'not needed' })
  })
})

describe('ClearedByPartner settings (CLE-218)', () => {
  it('getSettings / updateSettings use the partner key; the secret comes back once', async () => {
    const { f, calls } = fakeFetch([
      { status: 200, body: { partner_id: 'p1', execution_url: null, alert_webhook_configured: false, recent_alerts: [] } },
      { status: 200, body: { partner_id: 'p1', execution_url: 'https://exec.example/x', alert_webhook_configured: true, alert_webhook_secret: 'whsec_1' } },
    ])
    const p = partner(f)
    expect((await p.getSettings()).execution_url).toBeNull()
    expect(calls[0]!.url).toBe('https://api.test/v1/partner/settings')
    expect(calls[0]!.init.method).toBe('GET')
    expect(calls[0]!.init.headers.authorization).toBe('Bearer cb_partner_test')
    const r = await p.updateSettings({ execution_url: 'https://exec.example/x', alert_email: 'ops@p.example', alert_webhook_url: 'https://p.example/alerts', notify_url: null })
    expect(r.alert_webhook_secret).toBe('whsec_1')
    expect(calls[1]!.init.method).toBe('PATCH')
    expect(JSON.parse(calls[1]!.init.body)).toEqual({ execution_url: 'https://exec.example/x', alert_email: 'ops@p.example', alert_webhook_url: 'https://p.example/alerts', notify_url: null })
  })

  it('updateSettings surfaces a blocked URL as ClearedByError', async () => {
    const { f } = fakeFetch([{ status: 400, body: { error: { code: 'blocked_destination', message: 'execution_url: blocked destination' } } }])
    const err = await partner(f).updateSettings({ execution_url: 'https://10.0.0.1/x' }).catch((e) => e)
    expect(err).toBeInstanceOf(ClearedByError)
    expect(err.code).toBe('blocked_destination')
  })

  it('getSigningSecret fetches the org secret with the partner key + org_id', async () => {
    const { f, calls } = fakeFetch([{ status: 200, body: { org_id: 'org1', on_decision: { secret: 'abc' } } }])
    expect(await partner(f).getSigningSecret('org 1')).toBe('abc')
    expect(calls[0]!.url).toBe('https://api.test/v1/signing-secrets?org_id=org%201')
  })
})
