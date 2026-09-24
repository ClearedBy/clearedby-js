// CLE-226: runDoctor against a fake ClearedBy API and fake executors, all on
// 127.0.0.1. Nothing here talks to a real ClearedBy environment.
//
// The fake API implements just the endpoints the doctor uses, signs receipts
// with a throwaway Ed25519 key it publishes at /.well-known/clearedby-keys,
// and really dispatches approved items to the executor. The executors are
// built on verifyDispatch like a partner's would be.

import { createHash, generateKeyPairSync, sign as edSign } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { DispatchVerificationError, ReceiptRevokedError, signDispatchPayload, verifyDispatch, type DispatchEnvelope } from '../src/dispatch'
import { DOCTOR_ACTION, DOCTOR_EXTERNAL_ID, DOCTOR_HEADER, DOCTOR_ORG_NAME, formatDoctorReport, runDoctor, runDoctorCli, type DoctorReport } from '../src/doctor'
import { ClearedBy } from '../src/index'
import { canonicalJSON, receiptSigningHash, type AuthorizationReceipt } from '../src/receipt'
import { createReceiver } from '../../../examples/dispatch-receiver/src/receiver'

const AUDIENCE = 'https://exec.partner.example'
const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))))
})

type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void | Promise<void>
async function listen(handler: Handler): Promise<string> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      Promise.resolve(handler(req, Buffer.concat(chunks).toString('utf8'), res)).catch((err: unknown) => {
        res.writeHead(500).end(String(err))
      })
    })
  })
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}
const send = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
}

// ---------------------------------------------------------------- fake API

interface Item {
  id: string
  orgId: string
  action: string
  params: Record<string, unknown>
  audience: string | null
  status: 'pending' | 'cleared' | 'revoked'
  receipt?: AuthorizationReceipt
  delivery: { attempts: number, delivered: boolean, already_executed: boolean, last_status: number | null, last_error: string | null, gave_up: boolean } | null
  events: Array<{ kind: string, at: string, data: Record<string, unknown> }>
}

async function fakeClearedBy(opts: { dispatchTo: () => string, settings?: Partial<Record<string, unknown>> }) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer
  const publicKeyHex = spki.subarray(spki.length - 32).toString('hex')
  const orgs = new Map<string, Record<string, unknown>>()
  const secrets = new Map<string, string>()
  const items = new Map<string, Item>()
  const receiptIndex = new Map<string, string>() // receipt_id -> item id
  const keys: Array<{ org_id: string, key_id: string, prefix: string, name: string, active: boolean }> = []
  const webhooks: Array<Record<string, unknown>> = []
  const calls: string[] = []
  let n = 0
  const settings: Record<string, unknown> = {
    partner_id: 'ptn_1', retention_days: 90, execution_url: 'https://exec.partner.example/on-decision', notify_url: null,
    alert_email: 'oncall@partner.example', alert_webhook_url: null, alert_webhook_configured: false, recent_alerts: [], theme: null,
    ...opts.settings,
  }

  const mint = (item: Item): AuthorizationReceipt => {
    const now = Date.now()
    const params = item.params
    const unsigned: Omit<AuthorizationReceipt, 'sig'> = {
      v: 1, receipt_id: `rcpt_${++n}`, work_item_id: item.id, issuer: 'clearedby', principal: item.orgId, agent: null,
      action: item.action, params, params_hash: sha(canonicalJSON(params)), policy: { id: 'pol', version: 1 }, context_hash: null,
      decision: 'cleared', decided_by: 'user:rev', audience: item.audience, issued_at: new Date(now).toISOString(),
      expires_at: new Date(now + 600_000).toISOString(), nonce: `nonce${n}`, key_id: 'test1', alg: 'ed25519',
    }
    const r = { ...unsigned, sig: edSign(null, Buffer.from(receiptSigningHash(unsigned), 'utf8'), privateKey).toString('hex') }
    receiptIndex.set(r.receipt_id, item.id)
    return r
  }

  const dispatch = async (item: Item): Promise<void> => {
    const receipt = mint(item)
    const env: DispatchEnvelope = {
      v: 2, delivery_id: `${item.id}:cleared`, attempt: 1, event: 'on_decision', verdict: 'cleared', org_id: item.orgId,
      work_item_id: item.id, parent_item_id: null, action: item.action, params: item.params, params_hash: receipt.params_hash,
      decided_by: 'user:rev', rule: 'r', attestation: { seq: 1, hash: 'h' }, receipt, issued_at: new Date().toISOString(),
    }
    const body = JSON.stringify(env)
    const t = Math.floor(Date.now() / 1000)
    try {
      const res = await fetch(opts.dispatchTo(), {
        method: 'POST', body,
        headers: { 'content-type': 'application/json', 'clearedby-signature': `t=${t},v1=${signDispatchPayload(secrets.get(item.orgId)!, t, body)}`, 'clearedby-delivery-id': env.delivery_id },
      })
      const ok = res.ok || res.status === 409
      item.delivery = { attempts: 1, delivered: ok, already_executed: res.status === 409, last_status: res.status, last_error: ok ? null : await res.text(), gave_up: !ok }
    } catch (err) {
      item.delivery = { attempts: 1, delivered: false, already_executed: false, last_status: null, last_error: String(err), gave_up: true }
    }
  }

  const base = await listen(async (req, body, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const path = url.pathname
    const auth = req.headers.authorization ?? ''
    calls.push(`${req.method} ${path}`)
    const json = body ? JSON.parse(body) as Record<string, any> : {}
    let m: RegExpExecArray | null

    if (path === '/.well-known/clearedby-keys') return send(res, 200, { keys: [{ kid: 'test1', publicKeyHex }] })
    if ((m = /^\/v1\/receipts\/([^/]+)\/status$/.exec(path))) {
      const item = items.get(receiptIndex.get(m[1]!) ?? '')
      return send(res, 200, { receipt_id: m[1], work_item_id: item?.id ?? null, status: item?.status === 'revoked' ? 'revoked' : item ? 'valid' : 'unknown', revoked_at: null })
    }
    if (auth.startsWith('Bearer cb_partner_')) {
      if (auth !== 'Bearer cb_partner_good') return send(res, 401, { error: { code: 'invalid_key', message: 'bad key' } })
      if (path === '/v1/partner/settings') return send(res, 200, settings)
      if (path === '/v1/partner/orgs' && req.method === 'GET') {
        const ext = url.searchParams.get('external_id')
        return send(res, 200, { orgs: [...orgs.values()].filter((o) => ext === null || o.external_id === ext), next_after: null })
      }
      if (path === '/v1/partner/orgs' && req.method === 'POST') {
        const existing = [...orgs.values()].find((o) => o.external_id === json.external_id)
        if (existing) return send(res, 200, { ...existing, created: false })
        const org = { org_id: `org_${++n}`, external_id: json.external_id, name: json.name, shop_domain: null, shop_domains: [], currency: json.currency ?? null, execution_url: null, notify_url: null, theme: null, plan: 'partner', created_at: new Date().toISOString() }
        orgs.set(org.org_id, org)
        secrets.set(org.org_id, `odsec_${org.org_id}_secret`)
        keys.push({ org_id: org.org_id, key_id: `key_${++n}`, prefix: 'cb_live_fi', name: 'default', active: true })
        return send(res, 201, { ...org, created: true, api_key: 'cb_live_first' })
      }
      if ((m = /^\/v1\/partner\/orgs\/([^/]+)$/.exec(path))) {
        const org = orgs.get(m[1]!)
        return org ? send(res, 200, org) : send(res, 404, { error: { code: 'not_found', message: 'no org' } })
      }
      if ((m = /^\/v1\/partner\/orgs\/([^/]+)\/keys$/.exec(path)) && req.method === 'GET') return send(res, 200, { keys: keys.filter((k) => k.org_id === m![1]) })
      if ((m = /^\/v1\/partner\/orgs\/([^/]+)\/keys$/.exec(path))) {
        const k = { org_id: m[1]!, key_id: `key_${++n}`, prefix: 'cb_live_mi', name: json.name, active: true }
        keys.push(k)
        return send(res, 201, { ...k, api_key: 'cb_live_minted' })
      }
      if ((m = /^\/v1\/partner\/orgs\/([^/]+)\/keys\/([^/]+)$/.exec(path)) && req.method === 'DELETE') {
        const k = keys.find((x) => x.org_id === m![1] && x.key_id === m![2])
        if (!k) return send(res, 404, { error: { code: 'not_found', message: 'no key' } })
        k.active = false
        return send(res, 200, { ...k, revoked_at: new Date().toISOString() })
      }
      if (path === '/v1/webhooks' && url.searchParams.get('org_id')) return send(res, 200, { webhooks })
      if ((m = /^\/v1\/partner\/orgs\/([^/]+)\/reviewers\/([^/]+)$/.exec(path))) return send(res, 201, { external_subject: m[2], ...json, active: true })
      if (path === '/v1/signing-secrets') {
        const s = secrets.get(url.searchParams.get('org_id') ?? '')
        return s ? send(res, 200, { org_id: url.searchParams.get('org_id'), on_decision: { secret: s, applies_to: '', header: '' }, callback: { secret: 'cb', applies_to: '', header: '' }, rotation: '' }) : send(res, 404, { error: { code: 'not_found' } })
      }
      if (path === '/v1/auth/decision-token') return send(res, 201, { token: `cb_dt_${json.work_item_id}`, scope: 'decide' })
      if ((m = /^\/v1\/gate\/([^/]+)\/events$/.exec(path))) return send(res, 200, { events: (items.get(m[1]!)?.events ?? []).map((e) => ({ work_item_id: m![1], id: 'e', actor: null, ...e })) })
      if ((m = /^\/v1\/gate\/([^/]+)\/revoke$/.exec(path))) {
        const item = items.get(m[1]!)!
        if (item.events.some((e) => e.kind === 'completed' && String(e.data.actor).startsWith('api:'))) return send(res, 409, { error: { code: 'already_executed', message: 'done' } })
        item.status = 'revoked'
        return send(res, 200, { id: item.id, status: 'revoked', revoked_at: new Date().toISOString(), revoked_by: 'partner:ptn_1', dispatch: 'delivered', stopped_partial: false })
      }
      return send(res, 404, { error: { code: 'not_found', message: path } })
    }
    if (auth.startsWith('Bearer cb_dt_')) {
      if ((m = /^\/v1\/gate\/([^/]+)\/decide$/.exec(path))) {
        const item = items.get(m[1]!)!
        item.status = 'cleared'
        item.receipt = mint(item)
        setTimeout(() => void dispatch(item), 5)
        return send(res, 200, { status: 'cleared' })
      }
    }
    if (auth.startsWith('Bearer cb_live_')) {
      if (path === '/v1/gate' && req.method === 'POST') {
        const orgId = [...orgs.keys()][0]!
        const item: Item = { id: `item_${++n}`, orgId, action: json.action, params: json.params ?? {}, audience: json.audience ?? null, status: 'pending', delivery: null, events: [] }
        items.set(item.id, item)
        return send(res, 202, { id: item.id, status: 'pending' })
      }
      if ((m = /^\/v1\/gate\/([^/]+)\/delivery$/.exec(path))) {
        const item = items.get(m[1]!)!
        return send(res, 200, { id: item.id, status: item.status, delivery: item.delivery && { delivery_id: `${item.id}:cleared`, verdict: 'cleared', ...item.delivery }, deliveries: [] })
      }
      if ((m = /^\/v1\/gate\/([^/]+)\/receipt$/.exec(path))) return send(res, 200, items.get(m[1]!)!.receipt)
      if ((m = /^\/v1\/gate\/([^/]+)\/complete$/.exec(path))) {
        const item = items.get(m[1]!)!
        item.events.push({ kind: 'completed', at: new Date().toISOString(), data: { status: json.status, actor: 'api:cb_live_ex' } })
        return send(res, 200, { recorded: true, tier: 3, diverged: false, status: json.status })
      }
      if (path === '/v1/webhooks') return send(res, 200, { webhooks: [] })
    }
    return send(res, 404, { error: { code: 'not_found', message: `${req.method} ${path}` } })
  })
  return { base, orgs, secrets, items, calls, settings, keys, webhooks }
}

// ---------------------------------------------------------------- fake executors

type Mode = 'correct' | 'ignores_signatures' | 'double_executes' | 'no_check_status' | 'example'

/** examples/dispatch-receiver, wired the way its server.ts does it (partner-key secret lookup, completion reports). */
async function exampleReceiver(api: { base: string, secrets: Map<string, string> }) {
  const sideEffects: string[] = []
  const reporter = new ClearedBy({ apiKey: 'cb_live_executor', baseUrl: api.base })
  const handle = createReceiver(
    { secret: '', jwksUrl: `${api.base}/.well-known/clearedby-keys`, audience: AUDIENCE, checkStatus: true },
    async (_action, _params, id) => {
      sideEffects.push(id)
      return { ref: `ref_${id}` }
    },
    { secretFor: async (orgId) => api.secrets.get(orgId) ?? '', complete: (id, input) => reporter.complete(id, input) },
  )
  const url = await listen(async (req, rawBody, res) => {
    const { status, body } = await handle(rawBody, req.headers)
    send(res, status, body)
  })
  return { url, sideEffects }
}

async function executor(mode: Mode, api: { base: string, secrets: Map<string, string> }, fixedSecret?: string) {
  if (mode === 'example') return exampleReceiver(api)
  const executed = new Set<string>()
  const sideEffects: string[] = []
  let n = 0
  const url = await listen(async (req, rawBody, res) => {
    const env0 = JSON.parse(rawBody) as DispatchEnvelope
    let env: DispatchEnvelope = env0
    let params = env0.params
    if (mode !== 'ignores_signatures') {
      try {
        const v = await verifyDispatch(rawBody, req.headers, {
          secret: fixedSecret ?? api.secrets.get(env0.org_id) ?? '',
          jwksUrl: `${api.base}/.well-known/clearedby-keys`,
          audience: AUDIENCE,
          ...(mode === 'no_check_status' ? {} : { checkStatus: true }),
        })
        env = v.envelope
        params = v.params
      } catch (err) {
        if (err instanceof ReceiptRevokedError) return send(res, 200, { status: 'revoked', executed: false })
        if (err instanceof DispatchVerificationError) return send(res, 401, { error: err.code })
        throw err
      }
    }
    if (env.verdict !== 'cleared') return send(res, 200, { status: 'noted', executed: false })
    if (mode !== 'double_executes' && executed.has(env.work_item_id)) return send(res, 409, { status: 'already_executed', executed: false })
    executed.add(env.work_item_id)
    const dryRun = req.headers[DOCTOR_HEADER] === '1'
    if (env.action !== DOCTOR_ACTION && !dryRun) sideEffects.push(env.work_item_id)
    if (env.action === DOCTOR_ACTION && !dryRun && params.skip_complete !== true) {
      await new ClearedBy({ apiKey: 'cb_live_executor', baseUrl: api.base }).complete(env.work_item_id, { status: 'done', completionId: `${env.work_item_id}:final`, deliveryReceiptId: env.receipt?.receipt_id })
    }
    return send(res, 200, { status: 'executed', executed: true, execution_id: `exec_${++n}` })
  })
  return { url, sideEffects }
}

async function setup(mode: Mode, settings?: Partial<Record<string, unknown>>, fixedSecret?: string) {
  let target = ''
  const api = await fakeClearedBy({ dispatchTo: () => target, ...(settings ? { settings } : {}) })
  const ex = await executor(mode, api, fixedSecret)
  target = ex.url
  const run = (extra: Partial<Parameters<typeof runDoctor>[0]> = {}): Promise<DoctorReport> =>
    runDoctor({ partnerKey: 'cb_partner_good', baseUrl: api.base, executionUrl: ex.url, audience: AUDIENCE, pollIntervalMs: 20, waitSeconds: 5, ...extra })
  return { api, ex, run }
}

const status = (r: DoctorReport, id: string): string | undefined => r.checks.find((c) => c.id === id)?.status

// ---------------------------------------------------------------- tests

describe('runDoctor', () => {
  it('passes every check for a correct executor, including the real flow', async () => {
    const { api, ex, run } = await setup('correct')
    const r = await run({ full: true })
    const bad = r.checks.filter((c) => c.status === 'fail' || c.status === 'warn')
    expect(bad, formatDoctorReport(r)).toEqual([])
    expect(r.ok).toBe(true)
    for (const id of ['credentials.partner_key', 'credentials.sandbox_org', 'settings.execution_url', 'settings.alerts', 'settings.retention',
      'endpoint.signed', 'endpoint.bad_signature', 'endpoint.stale_timestamp', 'endpoint.tampered_params', 'endpoint.redelivery',
      'endpoint.forged_receipt', 'full.delivery', 'full.idempotency', 'full.completion', 'full.revoked']) {
      expect(status(r, id), id).toBe('pass')
    }
    // The sandbox org was created with the documented identity; nothing real was executed.
    const org = [...api.orgs.values()][0]!
    expect(org.external_id).toBe(DOCTOR_EXTERNAL_ID)
    expect(org.name).toBe(DOCTOR_ORG_NAME)
    expect(ex.sideEffects).toEqual([])
    // Every item the doctor created is a doctor.noop.
    expect([...api.items.values()].every((i) => i.action === DOCTOR_ACTION)).toBe(true)
  })

  it('revokes every org key it created, and checks webhooks with the partner key', async () => {
    const { api, run } = await setup('correct')
    api.webhooks.push({ id: 'wh_1', url: 'https://hooks.partner.example/cb', events: [], filters: {}, source: 'api', active: true, failed_count: 3 })
    const r = await run({ full: true })
    expect(api.keys.length).toBe(1) // the sandbox org's first key, used for --full
    expect(api.keys.every((k) => !k.active)).toBe(true)
    expect(r.checks.find((c) => c.id === 'cleanup.org_key')).toBeUndefined()
    const w = r.checks.find((c) => c.id === 'webhooks')!
    expect(w.status).toBe('warn')
    expect(w.detail).toMatch(/3 consecutive failed deliveries/)
    // A second run mints (and revokes) one more; nothing stays active.
    await run({ full: true })
    expect(api.keys.length).toBe(2)
    expect(api.keys.some((k) => k.active)).toBe(false)
  })

  it('reuses the sandbox org on the next run', async () => {
    const { api, run } = await setup('correct')
    await run()
    const r = await run()
    expect(api.orgs.size).toBe(1)
    expect(r.checks.find((c) => c.id === 'credentials.sandbox_org')?.title).toMatch(/^Using the sandbox org/)
  })

  it('without --full, skips the real flow and says why', async () => {
    const { run } = await setup('correct')
    const r = await run()
    expect(r.ok).toBe(true)
    expect(status(r, 'full.flow')).toBe('skip')
    expect(r.checks.find((c) => c.id === 'endpoint.redelivery')?.note).toMatch(/--full/)
  })

  it('fails b, c, d and the forged receipt for an executor that ignores signatures', async () => {
    const { run } = await setup('ignores_signatures')
    const r = await run()
    expect(r.ok).toBe(false)
    expect(status(r, 'endpoint.signed')).toBe('pass')
    expect(status(r, 'endpoint.bad_signature')).toBe('fail')
    expect(status(r, 'endpoint.stale_timestamp')).toBe('fail')
    expect(status(r, 'endpoint.tampered_params')).toBe('fail')
    expect(status(r, 'endpoint.forged_receipt')).toBe('fail')
    const bad = r.checks.find((c) => c.id === 'endpoint.bad_signature')!
    expect(bad.fix).toMatch(/verifyDispatch/)
    expect(bad.docs).toBe('https://www.clearedby.com/docs/partners/security#executor-rules')
  })

  it('flags an executor that executes a redelivered approval again', async () => {
    const { run } = await setup('double_executes')
    const r = await run({ full: true })
    expect(r.ok).toBe(false)
    const c = r.checks.find((x) => x.id === 'full.idempotency')!
    expect(c.status).toBe('fail')
    expect(c.detail).toMatch(/executed again/)
    expect(c.fix).toMatch(/already_executed/)
  })

  it('warns when a revoked approval is only stopped by dedupe (no checkStatus)', async () => {
    const { run } = await setup('no_check_status')
    const r = await run({ full: true })
    expect(status(r, 'full.idempotency')).toBe('pass')
    const c = r.checks.find((x) => x.id === 'full.revoked')!
    expect(c.status).toBe('warn')
    expect(c.fix).toMatch(/checkStatus: true/)
    expect(r.ok).toBe(true)
  })

  it('fails the real flow when the executor refuses a genuine dispatch, and skips what depends on it', async () => {
    const { run } = await setup('correct')
    const r = await run({ full: true, audience: 'https://someone-else.example' }) // the executor verifies AUDIENCE
    const c = r.checks.find((x) => x.id === 'full.delivery')!
    expect(c.status).toBe('fail')
    expect(c.detail).toMatch(/HTTP 401/)
    expect(c.fix).toMatch(/audience/)
    for (const id of ['full.idempotency', 'full.completion', 'full.revoked']) expect(status(r, id), id).toBe('skip')
    expect(r.ok).toBe(false)
  })

  it('reports a refused baseline and skips the refusal checks rather than passing them', async () => {
    // An executor that only knows one other org's secret refuses everything for the sandbox org.
    const { run } = await setup('correct', undefined, 'odsec_some_other_org')
    const r = await run()
    expect(status(r, 'endpoint.signed')).toBe('fail')
    expect(r.checks.find((c) => c.id === 'endpoint.signed')?.fix).toMatch(/getSigningSecret/)
    for (const id of ['endpoint.bad_signature', 'endpoint.stale_timestamp', 'endpoint.tampered_params', 'endpoint.redelivery', 'endpoint.forged_receipt']) {
      expect(status(r, id), id).toBe('skip')
    }
    expect(r.ok).toBe(false)
  })

  it('fails a missing or refused partner key and a missing execution_url', async () => {
    expect((await runDoctor({ partnerKey: '' })).checks[0]).toMatchObject({ id: 'credentials.partner_key', status: 'fail' })
    const { run } = await setup('correct', { execution_url: null })
    const refused = await run({ partnerKey: 'cb_partner_revoked' })
    expect(refused.checks).toHaveLength(1)
    expect(refused.checks[0]).toMatchObject({ status: 'fail' })
    const r = await run({ executionUrl: undefined })
    expect(status(r, 'settings.execution_url')).toBe('fail')
    expect(status(r, 'endpoint.signed')).toBe('skip')
    expect(r.ok).toBe(false)
  })

  it('warns about missing alerts and retention, and an http execution_url on localhost', async () => {
    const { run } = await setup('correct', { alert_email: null, retention_days: null, execution_url: 'http://localhost:8787/on-decision' })
    const r = await run()
    expect(status(r, 'settings.alerts')).toBe('warn')
    expect(status(r, 'settings.retention')).toBe('warn')
    expect(status(r, 'settings.execution_url')).toBe('warn')
    expect(r.ok).toBe(true)
  })

  it('fails an http execution_url that is not local', async () => {
    const { run } = await setup('correct', { execution_url: 'http://exec.partner.example/on-decision' })
    expect(status(await run(), 'settings.execution_url')).toBe('fail')
  })
})

describe('examples/dispatch-receiver', () => {
  it('passes the doctor, real flow included, and executes nothing', async () => {
    const { ex, run } = await setup('example')
    const r = await run({ full: true })
    const bad = r.checks.filter((c) => c.status === 'fail' || c.status === 'warn')
    expect(bad, formatDoctorReport(r)).toEqual([])
    expect(status(r, 'full.revoked')).toBe('pass')
    expect(status(r, 'full.completion')).toBe('pass')
    expect(ex.sideEffects).toEqual([])
  })
})

describe('runDoctorCli', () => {
  it('prints JSON and exits 0 when nothing failed, 1 when something did', async () => {
    const { api, ex } = await setup('correct')
    const out: string[] = []
    const io = { out: (s: string) => out.push(s), err: (s: string) => out.push(s) }
    const code = await runDoctorCli(['doctor', '--json', '--url', ex.url, `--audience=${AUDIENCE}`], { CLEAREDBY_PARTNER_KEY: 'cb_partner_good', CLEAREDBY_BASE_URL: api.base }, io)
    expect(code).toBe(0)
    const report = JSON.parse(out.join('\n')) as DoctorReport
    expect(report.ok).toBe(true)
    expect(report.execution_url).toBe(ex.url)

    const text: string[] = []
    const code2 = await runDoctorCli(['doctor', '--url', ex.url], { CLEAREDBY_PARTNER_KEY: 'cb_partner_nope', CLEAREDBY_BASE_URL: api.base }, { out: (s) => text.push(s), err: (s) => text.push(s) })
    expect(code2).toBe(1)
    expect(text.join('\n')).toMatch(/✗ Partner key/)
  })

  it('exits 2 on a usage error', async () => {
    const io = { out: () => {}, err: () => {} }
    expect(await runDoctorCli(['doctor', '--bogus'], {}, io)).toBe(2)
    expect(await runDoctorCli(['frobnicate'], {}, io)).toBe(2)
    expect(await runDoctorCli(['doctor', '--wait'], {}, io)).toBe(2)
  })
})
