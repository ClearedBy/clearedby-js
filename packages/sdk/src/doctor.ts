// @clearedby/sdk/doctor (CLE-226): the go-live checker.
//
//   npx @clearedby/sdk doctor            # or: import { runDoctor } from '@clearedby/sdk/doctor'
//
// Checks a partner integration end to end and says, for every failure, what
// to change. Aimed at the partner's developer or their AI coding agent.
//
//   1. credentials: the partner key works and the settings are readable;
//   2. settings: execution_url set and https, alerts and retention set;
//   3. the execution endpoint's security behaviour, with SYNTHETIC dispatches
//      the doctor signs itself with the sandbox org's signing secret and POSTs
//      straight to execution_url (marked `clearedby-doctor: 1`, action
//      `doctor.noop`): a correctly signed one is accepted; a bad signature, a
//      stale timestamp and tampered params are refused; a redelivery is
//      acknowledged; a `cleared` dispatch whose receipt ClearedBy never signed
//      is refused;
//   4. with `full`: the real flow in the sandbox org. A `doctor.noop` proposal
//      is approved by a sandbox reviewer, ClearedBy dispatches it for real, and
//      the doctor watches the delivery, replays the genuine receipt to test
//      idempotency, checks the executor reported completion, and replays a
//      REVOKED genuine receipt to see whether the executor checks status;
//   5. webhooks on the sandbox org (partner key + org_id).
//
// Any org key the run creates (the sandbox org's first key, or the one `full`
// mints) is revoked with revokeOrgKey before it returns, so keys never pile up.
//
// What the synthetic checks can't do: forge a receipt ClearedBy signed. So the
// synthetic "accepted" dispatch is a `rejected` verdict (it needs no receipt
// and authorises nothing: rule 2 says answer 2xx), and the only synthetic
// `cleared` dispatch carries a receipt signed by a throwaway key, which a
// correct executor MUST refuse. Everything that needs a genuine receipt
// (idempotency of a real execution, revocation) runs only with `full`.
//
// The doctor only ever writes to its own sandbox org (external_id
// `__doctor__`, "Doctor sandbox (safe to delete)"), or the org you name.
// Node 18+ only (node:crypto), like @clearedby/sdk/dispatch.

import { createHash, generateKeyPairSync, randomBytes, sign as ed25519Sign } from 'node:crypto'
import { signDispatchPayload, type DispatchEnvelope, type DispatchVerdict } from './dispatch.js'
import {
  ClearedBy,
  ClearedByApiError,
  ClearedByPartner,
  type ClearanceEvent,
  type DeliveryView,
  type PartnerOrg,
  type PartnerSettings,
} from './index.js'
import { canonicalJSON, receiptSigningHash, type AuthorizationReceipt } from './receipt.js'

/** The action every doctor proposal and synthetic dispatch uses. Executors must never act on it. */
export const DOCTOR_ACTION = 'doctor.noop'
/** Header on every request the doctor sends to your endpoint itself. Treat it as a dry run. */
export const DOCTOR_HEADER = 'clearedby-doctor'
/** external_id of the sandbox org the doctor creates when you don't pass `orgId`. */
export const DOCTOR_EXTERNAL_ID = '__doctor__'
export const DOCTOR_ORG_NAME = 'Doctor sandbox (safe to delete)'
/** external_subject of the sandbox reviewer that approves the doctor's proposals (`full`). */
export const DOCTOR_REVIEWER = '__doctor_reviewer__'

const DOCS = 'https://www.clearedby.com/docs/partners'
const DEFAULT_BASE = 'https://app.clearedby.com'

export type DoctorStatus = 'pass' | 'warn' | 'fail' | 'skip'
export type DoctorGroup = 'credentials' | 'settings' | 'endpoint' | 'full' | 'webhooks'

export interface DoctorCheck {
  /** Stable id, e.g. 'endpoint.bad_signature'. */
  id: string
  group: DoctorGroup
  title: string
  status: DoctorStatus
  /** What was observed. */
  detail?: string
  /** One-line fix (warn / fail). */
  fix?: string
  /** What this check can't prove, when that matters. */
  note?: string
  docs?: string
}

export interface DoctorReport {
  /** false when any check failed. */
  ok: boolean
  base_url: string
  org_id: string | null
  /** The endpoint the synthetic dispatches were sent to. */
  execution_url: string | null
  full: boolean
  counts: Record<DoctorStatus, number>
  checks: DoctorCheck[]
  started_at: string
  finished_at: string
}

export interface DoctorOptions {
  /** Your `cb_partner_` key. */
  partnerKey: string
  /** Default https://app.clearedby.com. */
  baseUrl?: string
  /** Use this org as the sandbox instead of creating / reusing `__doctor__`. */
  orgId?: string
  /** Send the synthetic dispatches here instead of the configured execution_url (e.g. a local build). */
  executionUrl?: string
  /** The `audience` your executor verifies. Used on `full` proposals and synthetic receipts. */
  audience?: string
  /** Also run the real flow in the sandbox org (proposal, approval, dispatch, completion, revoke). */
  full?: boolean
  /** `full`: how long to wait for the delivery and for your completion report. Default 120. */
  waitSeconds?: number
  /** `full`: an existing `cb_live_` key for the sandbox org. Without it the doctor mints one and revokes it at the end of the run. */
  orgKey?: string
  /** fetch for ClearedBy's API (tests). */
  fetch?: typeof fetch
  /** fetch for the POSTs to your endpoint (tests). Default the global fetch. */
  executorFetch?: typeof fetch
  /** Per-POST timeout for your endpoint. Default 10000 (ClearedBy's own limit). */
  requestTimeoutMs?: number
  /** `full`: polling interval. Default 2000. */
  pollIntervalMs?: number
  /** Called as each check finishes (progress output). */
  onCheck?: (check: DoctorCheck) => void
}

// ---------------------------------------------------------------- helpers

const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
function ulid(): string {
  let t = Date.now()
  let ts = ''
  for (let i = 0; i < 10; i++) {
    ts = CROCKFORD[t % 32] + ts
    t = Math.floor(t / 32)
  }
  const r = randomBytes(16)
  let rs = ''
  for (let i = 0; i < 16; i++) rs += CROCKFORD[(r[i] ?? 0) % 32]
  return ts + rs
}

function errText(err: unknown): string {
  if (err instanceof ClearedByApiError) return `${err.status}${err.code ? ` ${err.code}` : ''}: ${err.message}`
  return err instanceof Error ? err.message : String(err)
}

function isLocalHost(url: URL): boolean {
  return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname) || url.hostname.endsWith('.localhost')
}

interface Posted {
  ok: boolean
  status: number
  ms: number
  /** Parsed JSON body, or null. */
  json: Record<string, unknown> | null
  text: string
  /** Network error / timeout, when there was no HTTP answer. */
  error?: string
  timedOut?: boolean
}

/** The optional response contract: `{ executed: boolean, execution_id?: string, status?: string }`. */
function contract(p: Posted): { executed?: boolean, executionId?: string, status?: string, error?: string } {
  const j = p.json
  if (j === null) return {}
  const out: { executed?: boolean, executionId?: string, status?: string, error?: string } = {}
  if (typeof j.executed === 'boolean') out.executed = j.executed
  if (typeof j.execution_id === 'string' && j.execution_id !== '') out.executionId = j.execution_id
  if (typeof j.status === 'string') out.status = j.status
  if (typeof j.error === 'string') out.error = j.error
  else if (j.error !== null && typeof j.error === 'object' && typeof (j.error as { code?: unknown }).code === 'string') {
    out.error = (j.error as { code: string }).code
  }
  return out
}

function answer(p: Posted): string {
  if (p.error !== undefined) return p.timedOut ? `no answer within ${Math.round(p.ms / 1000)} s` : `no answer (${p.error})`
  const c = contract(p)
  const tag = c.error ?? c.status
  return `${p.status}${tag ? ` ${tag}` : ''} in ${p.ms} ms`
}

const is2xx = (p: Posted): boolean => p.error === undefined && p.status >= 200 && p.status < 300
const isRefusal = (p: Posted): boolean => p.error === undefined && p.status >= 400 && p.status < 500 && p.status !== 409

// ---------------------------------------------------------------- envelopes

const SYNTHETIC_PARAMS = { doctor: true, note: 'ClearedBy doctor synthetic check. Do nothing.' }

function syntheticEnvelope(orgId: string, verdict: DispatchVerdict, workItemId: string, attempt = 1): DispatchEnvelope {
  const params: Record<string, unknown> = { ...SYNTHETIC_PARAMS }
  return {
    v: 2,
    delivery_id: `${workItemId}:${verdict}`,
    attempt,
    event: 'on_decision',
    verdict,
    org_id: orgId,
    work_item_id: workItemId,
    parent_item_id: null,
    action: DOCTOR_ACTION,
    params,
    params_hash: sha256Hex(canonicalJSON(params)),
    decided_by: 'user:clearedby-doctor',
    rule: 'clearedby doctor',
    reason: 'ClearedBy doctor synthetic check',
    attestation: { seq: null, hash: null },
    issued_at: new Date().toISOString(),
  }
}

/** A receipt that looks right in every field but is signed by a throwaway key ClearedBy never published. */
function forgedReceipt(env: DispatchEnvelope, audience: string | undefined): AuthorizationReceipt {
  const { privateKey } = generateKeyPairSync('ed25519')
  const now = Date.now()
  const unsigned: Omit<AuthorizationReceipt, 'sig'> = {
    v: 1,
    receipt_id: ulid(),
    work_item_id: env.work_item_id,
    issuer: 'clearedby',
    principal: env.org_id,
    agent: null,
    action: env.action,
    params: env.params,
    params_hash: env.params_hash,
    policy: { id: 'doctor', version: 1 },
    context_hash: null,
    decision: 'cleared',
    decided_by: 'user:clearedby-doctor',
    audience: audience ?? null,
    issued_at: new Date(now).toISOString(),
    expires_at: new Date(now + 600_000).toISOString(),
    nonce: randomBytes(16).toString('hex'),
    key_id: 'clearedby-doctor-untrusted',
    alg: 'ed25519',
  }
  const sig = ed25519Sign(null, Buffer.from(receiptSigningHash(unsigned), 'utf8'), privateKey).toString('hex')
  return { ...unsigned, sig }
}

/** A v2 envelope for a GENUINE receipt (from the real flow), as a redelivery would carry it. */
function envelopeForReceipt(receipt: AuthorizationReceipt, attempt: number): DispatchEnvelope {
  return {
    v: 2,
    delivery_id: `${receipt.work_item_id}:cleared`,
    attempt,
    event: 'on_decision',
    verdict: 'cleared',
    org_id: receipt.principal,
    work_item_id: receipt.work_item_id,
    parent_item_id: null,
    action: receipt.action,
    params: receipt.params,
    params_hash: receipt.params_hash,
    decided_by: receipt.decided_by,
    rule: 'clearedby doctor replay',
    attestation: { seq: null, hash: null },
    receipt,
    issued_at: new Date().toISOString(),
  }
}

// ---------------------------------------------------------------- runDoctor

/**
 * Check a partner integration end to end before go-live. Never throws for a
 * failed check: every problem is a `fail` / `warn` in the report, with a fix.
 * `report.ok` is false when anything failed.
 */
export async function runDoctor(opts: DoctorOptions): Promise<DoctorReport> {
  const startedAt = new Date()
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/$/, '')
  const timeoutMs = opts.requestTimeoutMs ?? 10_000
  const pollMs = opts.pollIntervalMs ?? 2000
  const waitMs = (opts.waitSeconds ?? 120) * 1000
  const execFetch = opts.executorFetch ?? (globalThis.fetch as typeof fetch)
  const checks: DoctorCheck[] = []
  let orgId: string | null = null
  let target: string | null = null

  const add = (c: DoctorCheck): DoctorCheck => {
    checks.push(c)
    opts.onCheck?.(c)
    return c
  }
  const finish = (): DoctorReport => {
    const counts: Record<DoctorStatus, number> = { pass: 0, warn: 0, fail: 0, skip: 0 }
    for (const c of checks) counts[c.status]++
    return {
      ok: counts.fail === 0,
      base_url: baseUrl,
      org_id: orgId,
      execution_url: target,
      full: opts.full === true,
      counts,
      checks,
      started_at: startedAt.toISOString(),
      finished_at: new Date().toISOString(),
    }
  }

  // ---- 1. credentials
  if (!opts.partnerKey) {
    add({
      id: 'credentials.partner_key', group: 'credentials', title: 'Partner key', status: 'fail',
      detail: 'No partner key given.',
      fix: 'Set CLEAREDBY_PARTNER_KEY=cb_partner_... (or pass partnerKey).',
      docs: `${DOCS}/quickstart#install`,
    })
    return finish()
  }
  const partner = new ClearedByPartner({ partnerKey: opts.partnerKey, baseUrl, ...(opts.fetch ? { fetch: opts.fetch } : {}) })
  let settings: PartnerSettings
  try {
    settings = await partner.getSettings()
  } catch (err) {
    const auth = err instanceof ClearedByApiError && (err.status === 401 || err.status === 403)
    add({
      id: 'credentials.partner_key', group: 'credentials', title: 'Partner key', status: 'fail',
      detail: auth ? `ClearedBy refused the key (${errText(err)}).` : `Couldn't read your settings from ${baseUrl} (${errText(err)}).`,
      fix: auth
        ? `Use a live partner key (cb_partner_...)${opts.partnerKey.startsWith('cb_partner_') ? '' : ': this one does not start with cb_partner_'}, and check CLEAREDBY_BASE_URL points at the right environment.`
        : 'Check CLEAREDBY_BASE_URL and your network, then run the doctor again.',
      docs: `${DOCS}/api#err-credentials`,
    })
    return finish()
  }
  add({ id: 'credentials.partner_key', group: 'credentials', title: 'Partner key accepted; settings readable', status: 'pass' })

  // ---- sandbox org
  let org: PartnerOrg
  let createdOrgKey: string | undefined
  /** Org keys this run created: revoked in the finally below, so nothing piles up. */
  const minted: Array<{ keyId: string | null, prefix: string }> = []
  try {
    if (opts.orgId !== undefined) {
      org = await partner.getOrg(opts.orgId)
      add({ id: 'credentials.sandbox_org', group: 'credentials', title: `Using org ${org.org_id} ("${org.name}")`, status: 'pass' })
    } else {
      const found = await partner.findOrg(DOCTOR_EXTERNAL_ID)
      if (found !== null) {
        org = found
        add({ id: 'credentials.sandbox_org', group: 'credentials', title: `Using the sandbox org ${org.org_id} ("${org.name}")`, status: 'pass' })
      } else {
        const created = await partner.createOrg({ external_id: DOCTOR_EXTERNAL_ID, name: DOCTOR_ORG_NAME, currency: 'GBP' })
        org = created
        createdOrgKey = created.api_key
        if (created.api_key) minted.push({ keyId: null, prefix: created.api_key })
        add({
          id: 'credentials.sandbox_org', group: 'credentials', title: `Created the sandbox org ${org.org_id} ("${DOCTOR_ORG_NAME}")`, status: 'pass',
          detail: `external_id ${DOCTOR_EXTERNAL_ID}. The doctor reuses it on every run; it only ever holds doctor.noop test items.`,
        })
      }
    }
  } catch (err) {
    add({
      id: 'credentials.sandbox_org', group: 'credentials', title: 'Sandbox org', status: 'fail',
      detail: opts.orgId !== undefined ? `Couldn't read org ${opts.orgId} (${errText(err)}).` : `Couldn't find or create the sandbox org (${errText(err)}).`,
      fix: opts.orgId !== undefined ? 'Pass the id of an org your partner key created (listOrgs() shows them).' : 'Check the partner key can create orgs (POST /v1/partner/orgs).',
      docs: `${DOCS}/api#p-createorg`,
    })
    return finish()
  }
  orgId = org.org_id

  // Everything below may use a key the doctor minted; the finally at the end revokes it.
  try {

  // ---- 2. settings
  const configured = org.execution_url ?? settings.execution_url
  const where = org.execution_url !== null ? "the org's execution_url override" : 'your execution_url'
  if (configured === null || configured === '') {
    add({
      id: 'settings.execution_url', group: 'settings', title: 'execution_url is set', status: 'fail',
      detail: 'No execution_url: approved changes are dispatched nowhere.',
      fix: "partner.updateSettings({ execution_url: 'https://exec.yourapp.example/clearedby/on-decision' })",
      docs: `${DOCS}/quickstart#settings`,
    })
  } else {
    let u: URL | null = null
    try {
      u = new URL(configured)
    } catch {
      u = null
    }
    if (u === null) {
      add({ id: 'settings.execution_url', group: 'settings', title: 'execution_url is a valid URL', status: 'fail', detail: `${where} is "${configured}".`, fix: 'Set a full https URL.', docs: `${DOCS}/quickstart#settings` })
    } else if (u.protocol === 'https:') {
      add({ id: 'settings.execution_url', group: 'settings', title: `execution_url is https (${configured})`, status: 'pass' })
    } else if (isLocalHost(u)) {
      add({
        id: 'settings.execution_url', group: 'settings', title: 'execution_url is https', status: 'warn',
        detail: `${where} is ${configured}: fine for local testing, but ClearedBy only delivers to public https URLs.`,
        fix: 'Before go-live, set execution_url to your public https executor.',
        docs: `${DOCS}/quickstart#settings`,
      })
    } else {
      add({
        id: 'settings.execution_url', group: 'settings', title: 'execution_url is https', status: 'fail',
        detail: `${where} is ${configured}. Dispatches carry receipts and must be encrypted in transit.`,
        fix: 'Serve the executor over https and update execution_url.',
        docs: `${DOCS}/quickstart#settings`,
      })
    }
  }
  if (settings.alert_email || settings.alert_webhook_url) {
    add({ id: 'settings.alerts', group: 'settings', title: 'Partner alerts go somewhere', status: 'pass', detail: [settings.alert_email && `alert_email ${settings.alert_email}`, settings.alert_webhook_url && `alert_webhook_url ${settings.alert_webhook_url}`].filter(Boolean).join(', ') })
  } else {
    add({
      id: 'settings.alerts', group: 'settings', title: 'Partner alerts go somewhere', status: 'warn',
      detail: 'Neither alert_email nor alert_webhook_url is set: nobody hears about dispatch_gave_up (an approved change that is not being executed).',
      fix: "partner.updateSettings({ alert_email: 'oncall@yourapp.example' })",
      docs: `${DOCS}/concepts#alerts`,
    })
  }
  if (settings.retention_days !== null && settings.retention_days !== undefined) {
    add({ id: 'settings.retention', group: 'settings', title: `retention_days is set (${settings.retention_days})`, status: 'pass' })
  } else {
    add({
      id: 'settings.retention', group: 'settings', title: 'retention_days is set', status: 'warn',
      detail: 'No retention_days: clearance data is kept until erased.',
      fix: 'partner.updateSettings({ retention_days: 90 })',
      docs: `${DOCS}/security#proposals`,
    })
  }

  // ---- 3. the execution endpoint
  target = opts.executionUrl ?? configured ?? null
  const endpointIds: Array<[string, string]> = [
    ['endpoint.signed', 'a. A correctly signed dispatch is accepted'],
    ['endpoint.bad_signature', 'b. A bad signature is refused'],
    ['endpoint.stale_timestamp', 'c. A stale timestamp is refused'],
    ['endpoint.tampered_params', 'd. Tampered params are refused'],
    ['endpoint.redelivery', 'e. A redelivery is acknowledged'],
    ['endpoint.forged_receipt', 'f. A cleared dispatch with a receipt ClearedBy never signed is refused'],
  ]
  const skipEndpoint = (why: string): void => {
    for (const [id, title] of endpointIds) add({ id, group: 'endpoint', title, status: 'skip', detail: why })
  }

  let secret: string | null = null
  if (target === null || target === '') {
    skipEndpoint('No execution_url to test.')
  } else {
    try {
      secret = await partner.getSigningSecret(org.org_id)
    } catch (err) {
      add({
        id: 'endpoint.signing_secret', group: 'endpoint', title: "Read the sandbox org's signing secret", status: 'fail',
        detail: errText(err), fix: 'Check the partner key can read GET /v1/signing-secrets?org_id=.', docs: `${DOCS}/api#p-getsigningsecret`,
      })
      skipEndpoint('No signing secret to sign with.')
    }
  }

  const post = async (body: string, headers: Record<string, string>): Promise<Posted> => {
    const started = Date.now()
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), timeoutMs)
    try {
      const res = await execFetch(target as string, { method: 'POST', headers, body, signal: ctl.signal, redirect: 'manual' })
      const text = await res.text().catch(() => '')
      let json: Record<string, unknown> | null = null
      try {
        const parsed: unknown = JSON.parse(text)
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) json = parsed as Record<string, unknown>
      } catch {
        json = null
      }
      return { ok: res.ok, status: res.status, ms: Date.now() - started, json, text }
    } catch (err) {
      const timedOut = ctl.signal.aborted
      return { ok: false, status: 0, ms: Date.now() - started, json: null, text: '', error: timedOut ? 'timeout' : errText(err), ...(timedOut ? { timedOut: true } : {}) }
    } finally {
      clearTimeout(timer)
    }
  }
  const headersFor = (env: DispatchEnvelope, sig: string): Record<string, string> => ({
    'content-type': 'application/json',
    'user-agent': 'clearedby-doctor',
    'clearedby-event': 'on_decision',
    'clearedby-delivery-id': env.delivery_id,
    'clearedby-signature': sig,
    [DOCTOR_HEADER]: '1',
  })
  const sign = (s: string, t: number, body: string): string => `t=${t},v1=${signDispatchPayload(s, t, body)}`
  const nowSec = (): number => Math.floor(Date.now() / 1000)
  const refusedFix = 'Verify every POST with verifyDispatch(rawBody, headers, { secret, orgId, jwksUrl, audience }) over the raw body bytes, and answer 401 on any DispatchVerificationError.'

  /** Classify a request that MUST be refused. */
  const mustRefuse = (id: string, title: string, p: Posted, what: string): void => {
    if (isRefusal(p)) {
      add({ id, group: 'endpoint', title, status: 'pass', detail: `Refused: ${answer(p)}.` })
    } else if (is2xx(p) || p.status === 409) {
      add({ id, group: 'endpoint', title, status: 'fail', detail: `Your endpoint answered ${answer(p)} to ${what}.`, fix: refusedFix, docs: `${DOCS}/security#executor-rules` })
    } else {
      add({
        id, group: 'endpoint', title, status: 'warn',
        detail: `Not accepted, but not a clean refusal: ${answer(p)}. ClearedBy retries non-2xx answers, and a 5xx hides whether you verified at all.`,
        fix: 'Answer 401 for every DispatchVerificationError (503 only for status_unavailable).',
        docs: `${DOCS}/api#dispatchverificationerror`,
      })
    }
  }

  if (secret !== null && target !== null) {
    const s = secret
    const baseItem = ulid()
    const baseEnv = syntheticEnvelope(org.org_id, 'rejected', baseItem)
    const baseBody = JSON.stringify(baseEnv)
    const a = await post(baseBody, headersFor(baseEnv, sign(s, nowSec(), baseBody)))
    const aC = contract(a)
    let baselineOk = false
    if (is2xx(a) && aC.executed !== true) {
      baselineOk = true
      add({
        id: 'endpoint.signed', group: 'endpoint', title: 'a. A correctly signed dispatch is accepted', status: 'pass',
        detail: `A signed, non-cleared doctor.noop dispatch got ${answer(a)}.`,
        ...(a.ms > 5000 ? { note: `It took ${a.ms} ms: ClearedBy gives up after 10 s. Verify, dedupe, enqueue and answer 202; do the work in a job.` } : {}),
      })
    } else if (is2xx(a)) {
      add({
        id: 'endpoint.signed', group: 'endpoint', title: 'a. A correctly signed dispatch is accepted', status: 'fail',
        detail: `The dispatch was a "rejected" verdict for doctor.noop, and your endpoint said it executed it (${answer(a)}).`,
        fix: "Execute only verdict 'cleared', and never the action doctor.noop.",
        docs: `${DOCS}/security#executor-rules`,
      })
    } else if (a.error !== undefined) {
      add({
        id: 'endpoint.signed', group: 'endpoint', title: 'a. A correctly signed dispatch is accepted', status: 'fail',
        detail: `${target}: ${answer(a)}.`,
        fix: a.timedOut ? 'Answer within 10 s: verify, dedupe, enqueue, reply 202, and do the work in a job.' : 'Make sure the executor is deployed and reachable at execution_url.',
        docs: `${DOCS}/quickstart#executor`,
      })
    } else {
      const unauthorized = a.status === 401 || a.status === 400 || a.status === 403
      add({
        id: 'endpoint.signed', group: 'endpoint', title: 'a. A correctly signed dispatch is accepted', status: 'fail',
        detail: `A correctly signed dispatch for org ${org.org_id} got ${answer(a)}.`,
        fix: unauthorized
          ? `Your executor doesn't accept this org's signature. Look the secret up by envelope.org_id (partner.getSigningSecret(orgId)) instead of one fixed secret, or run the doctor with --org <an org your executor knows>. Answer 2xx to non-cleared verdicts.`
          : 'Answer 2xx to a verified dispatch (non-cleared verdicts authorise nothing: acknowledge and do nothing).',
        docs: `${DOCS}/security#executor-rules`,
      })
    }

    if (!baselineOk) {
      for (const [id, title] of endpointIds.slice(1)) {
        add({ id, group: 'endpoint', title, status: 'skip', detail: 'Skipped: the correctly signed dispatch (a) was not accepted, so a refusal here would prove nothing.' })
      }
    } else {
      // b. bad signature: a valid-looking header made with the wrong secret.
      {
        const env = syntheticEnvelope(org.org_id, 'rejected', ulid())
        const body = JSON.stringify(env)
        const p = await post(body, headersFor(env, sign(`wrong_${randomBytes(16).toString('hex')}`, nowSec(), body)))
        mustRefuse('endpoint.bad_signature', 'b. A bad signature is refused', p, 'a dispatch signed with the wrong secret')
      }
      // c. stale timestamp: correctly signed, 10 minutes old.
      {
        const env = syntheticEnvelope(org.org_id, 'rejected', ulid())
        const body = JSON.stringify(env)
        const p = await post(body, headersFor(env, sign(s, nowSec() - 600, body)))
        mustRefuse('endpoint.stale_timestamp', 'c. A stale timestamp is refused', p, 'a correctly signed dispatch whose timestamp is 10 minutes old (a replay)')
      }
      // d. tampered params: signed over the original body, params changed after
      //    (params_hash recomputed, so only the signature can catch it).
      {
        const env = syntheticEnvelope(org.org_id, 'rejected', ulid())
        const body = JSON.stringify(env)
        const sig = sign(s, nowSec(), body)
        const params = { ...env.params, amount: 999999 }
        const tampered = JSON.stringify({ ...env, params, params_hash: sha256Hex(canonicalJSON(params)) })
        const p = await post(tampered, headersFor(env, sig))
        mustRefuse('endpoint.tampered_params', 'd. Tampered params are refused', p, 'a dispatch whose params were changed after signing')
      }
      // e. redelivery: the same work item again, attempt 2, freshly signed.
      {
        const env = { ...syntheticEnvelope(org.org_id, 'rejected', baseItem, 2) }
        const body = JSON.stringify(env)
        const p = await post(body, headersFor(env, sign(s, nowSec(), body)))
        const c = contract(p)
        const title = 'e. A redelivery is acknowledged'
        const note = 'A rejected verdict authorises nothing, so this only shows redeliveries are acknowledged. Whether a redelivered cleared dispatch executes twice needs a genuine receipt: run with --full.'
        if ((is2xx(p) || p.status === 409) && c.executed === true) {
          const twice = aC.executionId !== undefined && c.executionId !== undefined && aC.executionId !== c.executionId
          add({
            id: 'endpoint.redelivery', group: 'endpoint', title, status: 'fail',
            detail: twice
              ? `The redelivery was executed again: execution ${c.executionId}, after ${aC.executionId} for the first delivery.`
              : `The redelivery of a rejected verdict says it executed (${answer(p)}).`,
            fix: 'Dedupe on work_item_id with a unique index written before executing, and answer 409 {"status":"already_executed"} to repeats.',
            docs: `${DOCS}/security#executor-rules`,
          })
        } else if (is2xx(p) || p.status === 409) {
          add({ id: 'endpoint.redelivery', group: 'endpoint', title, status: 'pass', detail: `Attempt 2 of the same work item got ${answer(p)}.`, note })
        } else {
          add({
            id: 'endpoint.redelivery', group: 'endpoint', title, status: 'fail',
            detail: `Attempt 2 of the same work item got ${answer(p)}. ClearedBy retries anything but 2xx or 409, so this delivery would be retried until it gives up.`,
            fix: 'Answer 2xx (or 409 {"status":"already_executed"}) to a verified redelivery.',
            docs: `${DOCS}/concepts#dispatch-routing`,
          })
        }
      }
      // f. a cleared dispatch, validly HMAC'd, whose receipt is signed by a key ClearedBy never published.
      {
        const env = syntheticEnvelope(org.org_id, 'cleared', ulid())
        env.receipt = forgedReceipt(env, opts.audience)
        const body = JSON.stringify(env)
        const p = await post(body, headersFor(env, sign(s, nowSec(), body)))
        const title = 'f. A cleared dispatch with a receipt ClearedBy never signed is refused'
        if (isRefusal(p)) {
          add({ id: 'endpoint.forged_receipt', group: 'endpoint', title, status: 'pass', detail: `Refused: ${answer(p)}.` })
        } else if (is2xx(p) || p.status === 409) {
          add({
            id: 'endpoint.forged_receipt', group: 'endpoint', title, status: 'fail',
            detail: `Your endpoint answered ${answer(p)} to a correctly HMAC-signed cleared dispatch whose receipt ClearedBy never signed. Anyone holding one of the org's API keys (your agent included) can read the signing secret and forge that.`,
            fix: "Verify the receipt: verifyDispatch with jwksUrl (or keys) and audience refuses it with receipt_invalid. Never execute on the HMAC alone.",
            docs: `${DOCS}/security#threat-model`,
          })
        } else {
          add({
            id: 'endpoint.forged_receipt', group: 'endpoint', title, status: 'warn',
            detail: `Not accepted, but not a clean refusal: ${answer(p)}.`,
            fix: 'Answer 401 for a receipt that fails verification.',
            docs: `${DOCS}/api#dispatchverificationerror`,
          })
        }
      }
    }
  }

  // ---- 4. the real flow (full)
  let orgKey: string | undefined = opts.orgKey ?? createdOrgKey
  if (opts.full !== true) {
    add({
      id: 'full.flow', group: 'full', title: 'Real flow: approval, dispatch, idempotency, completion, revocation', status: 'skip',
      detail: 'Run with --full to push a real doctor.noop approval through the sandbox org. It is the only way to test idempotency and revocation with a receipt ClearedBy actually signed.',
    })
  } else if (target === null || configured === null) {
    add({ id: 'full.flow', group: 'full', title: 'Real flow', status: 'skip', detail: 'No execution_url: nothing would be dispatched.' })
  } else {
    await runFull()
  }

  async function runFull(): Promise<void> {
    if (orgKey === undefined) {
      try {
        const k = await partner.createOrgKey(org.org_id, { name: 'clearedby-doctor' })
        minted.push({ keyId: k.key_id, prefix: k.api_key })
        orgKey = k.api_key
      } catch (err) {
        add({ id: 'full.flow', group: 'full', title: 'Real flow', status: 'fail', detail: `Couldn't mint a key for the sandbox org (${errText(err)}).`, fix: 'Pass an existing sandbox org key with --org-key.', docs: `${DOCS}/api#p-createorgkey` })
        return
      }
    }
    const agent = new ClearedBy({ apiKey: orgKey, baseUrl, ...(opts.fetch ? { fetch: opts.fetch } : {}) })
    try {
      await partner.upsertReviewer(org.org_id, DOCTOR_REVIEWER, { display_name: 'ClearedBy doctor (automated)', role: 'reviewer', authority: { [DOCTOR_ACTION]: 0 } })
    } catch (err) {
      add({ id: 'full.flow', group: 'full', title: 'Real flow', status: 'fail', detail: `Couldn't create the sandbox reviewer (${errText(err)}).`, docs: `${DOCS}/api#p-upsertreviewer` })
      return
    }
    const runId = ulid()

    /** Propose + approve a doctor.noop; returns the clearance id, or null after adding a fail. */
    const proposeAndApprove = async (purpose: string, extra: Record<string, unknown>, checkId: string): Promise<string | null> => {
      try {
        const g = await agent.gate({
          action: DOCTOR_ACTION,
          params: { doctor: true, purpose, ...extra },
          context: { summary: `ClearedBy doctor: ${purpose} (a harmless test, do nothing)` },
          ...(opts.audience !== undefined ? { audience: opts.audience } : {}),
          idempotencyKey: `doctor:${runId}:${purpose}`,
        })
        if (g.status === 'cleared') return g.id
        if (g.status !== 'pending' && g.status !== 'escalated') {
          add({ id: checkId, group: 'full', title: 'Propose and approve a doctor.noop', status: 'fail', detail: `The sandbox org's rules answered '${g.status}'${g.rule ? ` (${g.rule})` : ''}.`, fix: 'Use a sandbox org without rules that reject unknown actions (the default rules hold them for a person).', docs: `${DOCS}/concepts#approval-rules` })
          return null
        }
        const { token } = await partner.createDecisionToken({ orgId: org.org_id, externalSubject: DOCTOR_REVIEWER, workItemId: g.id })
        const d = await partner.decide(g.id, { decision: 'clear' }, { token })
        if (d.status !== 'cleared') {
          add({ id: checkId, group: 'full', title: 'Propose and approve a doctor.noop', status: 'fail', detail: `The approval came back '${d.status}'.`, docs: `${DOCS}/api#p-decide` })
          return null
        }
        return g.id
      } catch (err) {
        add({ id: checkId, group: 'full', title: 'Propose and approve a doctor.noop', status: 'fail', detail: errText(err), docs: `${DOCS}/api#cb-gate` })
        return null
      }
    }

    /** Poll GET /v1/gate/:id/delivery until delivered, gave up, or the deadline. */
    const awaitDelivery = async (id: string, deadline: number): Promise<{ view: DeliveryView | null, error?: string }> => {
      let view: DeliveryView | null = null
      while (true) {
        try {
          view = (await agent.delivery(id)).delivery
        } catch (err) {
          return { view, error: errText(err) }
        }
        if (view !== null && (view.delivered || view.gave_up)) return { view }
        if (Date.now() >= deadline) return { view }
        await sleep(pollMs)
      }
    }

    // 4a. delivery + 4b. idempotency + 4c. completion
    const approvedAt = Date.now()
    let delivered = false
    const notDelivered = 'Skipped: the real dispatch was not delivered (see above).'
    const id1 = await proposeAndApprove('completion_check', {}, 'full.delivery')
    if (id1 !== null) {
      const { view, error } = await awaitDelivery(id1, approvedAt + waitMs)
      if (error !== undefined) {
        add({ id: 'full.delivery', group: 'full', title: 'The real dispatch reached your endpoint', status: 'fail', detail: `Couldn't read the delivery state (${error}).`, docs: `${DOCS}/api#cb-delivery` })
      } else if (view?.delivered) {
        add({
          id: 'full.delivery', group: 'full', title: 'The real dispatch reached your endpoint', status: 'pass',
          detail: `Clearance ${id1}: delivered on attempt ${view.attempts} (HTTP ${view.last_status ?? '?'}${view.already_executed ? ', already_executed' : ''}).`,
        })
        delivered = true
        await replayForIdempotency(id1, view)
      } else {
        const last = view === null ? 'nothing was dispatched' : `${view.attempts} attempt(s), last HTTP ${view.last_status ?? '-'}${view.last_error ? ` (${view.last_error})` : ''}${view.gave_up ? ', gave up' : ''}`
        const refused = view !== null && (view.last_status === 401 || view.last_status === 400)
        add({
          id: 'full.delivery', group: 'full', title: 'The real dispatch reached your endpoint', status: 'fail',
          detail: `Clearance ${id1} was approved, but after ${Math.round((Date.now() - approvedAt) / 1000)} s: ${last}.`,
          fix: refused
            ? `Your executor refused a genuine dispatch. Check it verifies with this org's secret, jwksUrl ${baseUrl}/.well-known/clearedby-keys and the right audience${opts.audience ? '' : ' (pass --audience if you verify one)'}.`
            : view === null ? 'Set execution_url (partner or org override) so cleared items are dispatched.' : 'Fix the executor, then POST /v1/gate/:id/redeliver (or run the doctor again).',
          docs: `${DOCS}/concepts#dispatch-routing`,
        })
      }
    }
    if (!delivered) {
      for (const [id, title] of [['full.idempotency', 'A redelivered approval is not executed twice'], ['full.completion', 'Your executor reported completion'], ['full.revoked', 'A revoked approval is not executed']] as const) {
        add({ id, group: 'full', title, status: 'skip', detail: notDelivered })
      }
      return
    }
    {
      const id = id1 as string
      // completion: an executor report (actor api:*), not the dispatch witness row.
      const deadline = approvedAt + waitMs
      let reported: ClearanceEvent | undefined
      let readError: string | undefined
      while (true) {
        try {
          const events = await partner.events(org.org_id, id)
          reported = events.find((e) => e.kind === 'completed' && typeof e.data.actor === 'string' && e.data.actor.startsWith('api:'))
        } catch (err) {
          readError = errText(err)
          break
        }
        if (reported !== undefined || Date.now() >= deadline) break
        await sleep(pollMs)
      }
      if (reported !== undefined) {
        add({ id: 'full.completion', group: 'full', title: 'Your executor reported completion', status: 'pass', detail: `complete() recorded status '${String(reported.data.status)}' ${Math.round((Date.parse(reported.at) - approvedAt) / 1000)} s after approval.` })
      } else {
        add({
          id: 'full.completion', group: 'full', title: 'Your executor reported completion', status: 'warn',
          detail: readError !== undefined ? `Couldn't read the clearance's events (${readError}).` : `No completion report within ${Math.round(waitMs / 1000)} s of approval. A 2xx to the dispatch only proves you received it.`,
          fix: "For doctor.noop, touch nothing and call complete(id, { status: 'done', completionId, deliveryReceiptId: receipt.receipt_id }). Do the same for every real action once it has run.",
          docs: `${DOCS}/quickstart#complete`,
        })
      }
    }

    // 4d. revocation: approve, let it be delivered, revoke, replay the genuine (now revoked) receipt.
    const id2 = await proposeAndApprove('revoke_check', { skip_complete: true }, 'full.revoked')
    if (id2 !== null) {
      const title = 'A revoked approval is not executed'
      const { view } = await awaitDelivery(id2, Date.now() + waitMs)
      if (!view?.delivered) {
        add({ id: 'full.revoked', group: 'full', title, status: 'skip', detail: 'Skipped: the dispatch for the revoke check was not delivered (see the delivery check).' })
        return
      }
      try {
        await partner.revoke(org.org_id, id2, 'ClearedBy doctor revoke check')
      } catch (err) {
        const done = err instanceof ClearedByApiError && err.code === 'already_executed'
        add({
          id: 'full.revoked', group: 'full', title, status: done ? 'warn' : 'fail',
          detail: done
            ? 'Your executor reported completion for the revoke-check item (params.skip_complete: true) before the doctor could revoke it, so revocation could not be tested.'
            : `Couldn't revoke the test item (${errText(err)}).`,
          ...(done ? { fix: 'For doctor.noop with params.skip_complete: true, don\'t call complete().' } : {}),
          docs: `${DOCS}/security#executor-rules`,
        })
        return
      }
      let receipt: AuthorizationReceipt
      try {
        receipt = await agent.receipt(id2)
      } catch (err) {
        add({ id: 'full.revoked', group: 'full', title, status: 'skip', detail: `Couldn't fetch the receipt to replay (${errText(err)}).` })
        return
      }
      const env = envelopeForReceipt(receipt, view.attempts + 1)
      const body = JSON.stringify(env)
      const p = await post(body, headersFor(env, sign(secret ?? (await partner.getSigningSecret(org.org_id)), nowSec(), body)))
      const c = contract(p)
      const checkStatusFix = 'Pass checkStatus: true to verifyDispatch for anything irreversible (refunds, cancellations, payouts): an approval can be revoked after the dispatch left ClearedBy. On ReceiptRevokedError, don\'t execute; answer 2xx {"status":"revoked"}.'
      if (c.executed === true) {
        add({ id: 'full.revoked', group: 'full', title, status: 'fail', detail: `A genuine but revoked approval was replayed and your endpoint says it executed it (${answer(p)}).`, fix: checkStatusFix, docs: `${DOCS}/security#executor-rules` })
      } else if (c.error === 'receipt_revoked' || c.status === 'revoked') {
        add({ id: 'full.revoked', group: 'full', title, status: 'pass', detail: `Replaying the revoked approval got ${answer(p)}: your executor checks the receipt status.` })
      } else if (p.status === 409) {
        add({
          id: 'full.revoked', group: 'full', title, status: 'warn',
          detail: `Replaying the revoked approval got ${answer(p)}: dedupe answered, so nothing checked whether it was revoked. Safe here only because the first delivery already ran.`,
          fix: checkStatusFix, docs: `${DOCS}/security#executor-rules`,
        })
      } else if (isRefusal(p)) {
        add({
          id: 'full.revoked', group: 'full', title, status: 'pass',
          detail: `Replaying the revoked approval was refused (${answer(p)}).`,
          note: 'The answer does not say why. Return {"error":"receipt_revoked"} (or {"status":"revoked"}) so the doctor can tell a status check from another refusal.',
        })
      } else {
        add({
          id: 'full.revoked', group: 'full', title, status: 'warn',
          detail: `Replaying the revoked approval got ${answer(p)}, and the answer doesn't say whether it executed.`,
          fix: `${checkStatusFix} Answering {"executed": false} or {"status":"revoked"} lets the doctor prove it.`,
          docs: `${DOCS}/security#executor-rules`,
        })
      }
    }
  }

  async function replayForIdempotency(id: string, view: DeliveryView): Promise<void> {
    const title = 'A redelivered approval is not executed twice'
    let receipt: AuthorizationReceipt
    try {
      receipt = await (new ClearedBy({ apiKey: orgKey as string, baseUrl, ...(opts.fetch ? { fetch: opts.fetch } : {}) })).receipt(id)
    } catch (err) {
      add({ id: 'full.idempotency', group: 'full', title, status: 'skip', detail: `Couldn't fetch the receipt to replay (${errText(err)}).` })
      return
    }
    const env = envelopeForReceipt(receipt, view.attempts + 1)
    const body = JSON.stringify(env)
    const p = await post(body, headersFor(env, sign(secret as string, nowSec(), body)))
    const c = contract(p)
    const note = 'The doctor sees only your answers. It proves double execution when you say executed: true; it cannot see side effects you don\'t report.'
    const dedupeFix = 'Dedupe on work_item_id with a unique index written before executing, and answer 409 {"status":"already_executed"} to repeats.'
    if (p.status === 409 || c.status === 'already_executed' || (is2xx(p) && c.executed === false)) {
      add({ id: 'full.idempotency', group: 'full', title, status: 'pass', detail: `Replaying the delivered approval (attempt ${env.attempt}, genuine receipt) got ${answer(p)}.`, note })
    } else if (is2xx(p) && c.executed === true) {
      add({ id: 'full.idempotency', group: 'full', title, status: 'fail', detail: `ClearedBy had already delivered ${id}, and the replay was executed again (${answer(p)}${c.executionId ? `, execution ${c.executionId}` : ''}).`, fix: dedupeFix, docs: `${DOCS}/security#executor-rules` })
    } else if (is2xx(p)) {
      add({
        id: 'full.idempotency', group: 'full', title, status: 'warn',
        detail: `The replay got ${answer(p)}, which doesn't say whether it executed again.`,
        fix: `${dedupeFix} Or answer {"executed": false} so it can be proven.`,
        note, docs: `${DOCS}/security#executor-rules`,
      })
    } else if (isRefusal(p)) {
      add({
        id: 'full.idempotency', group: 'full', title, status: 'warn',
        detail: `The replay of a genuine receipt was refused (${answer(p)}), so idempotency couldn't be observed. If it was receipt_invalid, check your audience / jwksUrl.`,
        docs: `${DOCS}/api#verifydispatch`,
      })
    } else {
      add({ id: 'full.idempotency', group: 'full', title, status: 'fail', detail: `The replay got ${answer(p)}. ClearedBy retries anything but 2xx or 409, so a redelivery would keep retrying.`, fix: dedupeFix, docs: `${DOCS}/concepts#dispatch-routing` })
    }
  }

  // ---- 5. webhooks on the sandbox org (partner key + org_id)
  {
    try {
      const hooks = await partner.listWebhooks(org.org_id)
      if (hooks.length === 0) {
        add({ id: 'webhooks', group: 'webhooks', title: 'Webhook subscriptions', status: 'skip', detail: 'No webhook subscriptions on the sandbox org.' })
      } else {
        const bad = hooks.filter((h) => !h.active || (h.failed_count ?? 0) > 0)
        add(bad.length === 0
          ? { id: 'webhooks', group: 'webhooks', title: `${hooks.length} webhook subscription(s) healthy`, status: 'pass' }
          : {
            id: 'webhooks', group: 'webhooks', title: 'Webhook subscriptions healthy', status: 'warn',
            detail: bad.map((h) => `${h.url}: ${h.active ? `${h.failed_count} consecutive failed deliveries` : 'deactivated'}`).join('; '),
            fix: 'Answer 2xx within 10 s after verifying X-ClearedBy-Signature; the 21st consecutive failure deactivates a subscription.',
            docs: `${DOCS}/security#webhooks`,
          })
      }
    } catch (err) {
      add({ id: 'webhooks', group: 'webhooks', title: 'Webhook subscriptions', status: 'skip', detail: `Couldn't list them (${errText(err)}).` })
    }
  }

  } finally {
    await revokeMinted()
  }
  return finish()

  /** Revoke every org key this run created (best effort: a failure is reported, never thrown). */
  async function revokeMinted(): Promise<void> {
    if (minted.length === 0) return
    let keys: Awaited<ReturnType<typeof partner.listOrgKeys>> | null = null
    for (const m of minted) {
      let keyId = m.keyId
      try {
        if (keyId === null) {
          keys ??= await partner.listOrgKeys(org.org_id)
          const hits = keys.filter((k) => k.active && m.prefix.startsWith(k.prefix))
          keyId = hits.length === 1 ? hits[0]!.key_id : null
          if (keyId === null) throw new Error('could not identify it among the org keys')
        }
        await partner.revokeOrgKey(org.org_id, keyId)
      } catch (err) {
        add({
          id: 'cleanup.org_key', group: 'full', title: 'Revoke the temporary org key', status: 'warn',
          detail: `The doctor couldn't revoke the key it created (${m.prefix.slice(0, 12)}..., ${errText(err)}).`,
          fix: 'Revoke it with partner.listOrgKeys(orgId) and partner.revokeOrgKey(orgId, keyId).',
          docs: `${DOCS}/api#p-revokeorgkey`,
        })
      }
    }
  }
}

// ---------------------------------------------------------------- output

const GROUP_TITLES: Record<DoctorGroup, string> = {
  credentials: 'Credentials',
  settings: 'Settings',
  endpoint: 'Execution endpoint (synthetic dispatches signed by the doctor)',
  full: 'Real flow in the sandbox org',
  webhooks: 'Webhooks',
}

/** The human-readable report: ✓ / ⚠ / ✗ per check, with a fix and a docs link for each problem. */
export function formatDoctorReport(report: DoctorReport, opts: { color?: boolean } = {}): string {
  const color = opts.color === true
  const paint = (code: string, s: string): string => (color ? `\u001b[${code}m${s}\u001b[0m` : s)
  const mark: Record<DoctorStatus, string> = {
    pass: paint('32', '✓'),
    warn: paint('33', '⚠'),
    fail: paint('31', '✗'),
    skip: paint('90', '-'),
  }
  const lines: string[] = [paint('1', 'ClearedBy doctor'), `  API       ${report.base_url}`]
  if (report.org_id) lines.push(`  Org       ${report.org_id}`)
  if (report.execution_url) lines.push(`  Endpoint  ${report.execution_url}`)
  for (const group of Object.keys(GROUP_TITLES) as DoctorGroup[]) {
    const cs = report.checks.filter((c) => c.group === group)
    if (cs.length === 0) continue
    lines.push('', paint('1', GROUP_TITLES[group]))
    for (const c of cs) {
      lines.push(`  ${mark[c.status]} ${c.title}`)
      if (c.detail) lines.push(`      ${paint('90', c.detail)}`)
      if (c.fix && (c.status === 'fail' || c.status === 'warn')) lines.push(`      Fix: ${c.fix}`)
      if (c.note) lines.push(`      ${paint('90', `Note: ${c.note}`)}`)
      if (c.docs && (c.status === 'fail' || c.status === 'warn')) lines.push(`      Docs: ${c.docs}`)
    }
  }
  const { pass, warn, fail, skip } = report.counts
  lines.push(
    '',
    `${pass} passed, ${warn} warning${warn === 1 ? '' : 's'}, ${fail} failed, ${skip} skipped. ${fail === 0 ? paint('32', warn === 0 ? 'Ready for go-live.' : 'No blockers; review the warnings.') : paint('31', 'Not ready for go-live: fix the ✗ items and run it again.')}`,
  )
  return lines.join('\n')
}

// ---------------------------------------------------------------- CLI

const USAGE = `Usage: npx @clearedby/sdk doctor [options]

Checks your ClearedBy partner integration end to end before go-live.

Environment:
  CLEAREDBY_PARTNER_KEY   your cb_partner_ key (required)
  CLEAREDBY_BASE_URL      default https://app.clearedby.com
  CLEAREDBY_ORG_KEY       optional cb_live_ key for the sandbox org

Options:
  --org <id>          use this org as the sandbox (default: create/reuse "${DOCTOR_EXTERNAL_ID}")
  --url <url>         send the synthetic dispatches here instead of execution_url
  --audience <aud>    the audience your executor verifies
  --full              also run the real flow (proposal, approval, dispatch, completion, revoke)
  --wait <seconds>    --full: how long to wait for delivery and completion (default 120)
  --base-url <url>    override CLEAREDBY_BASE_URL
  --org-key <key>     override CLEAREDBY_ORG_KEY
  --json              print the report as JSON (for CI)
  --no-color          plain output
  -h, --help          this help

Exit code: 0 when nothing failed, 1 when any check failed, 2 for a usage error.`

/**
 * The `clearedby doctor` command line (what `npx @clearedby/sdk doctor` runs).
 * `argv` excludes node and the script (e.g. ['doctor', '--full']). Returns the
 * exit code: 0 nothing failed, 1 a check failed, 2 a usage error.
 */
export async function runDoctorCli(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
  io: { out: (s: string) => void, err: (s: string) => void, color?: boolean } = {
    out: (s) => process.stdout.write(`${s}\n`),
    err: (s) => process.stderr.write(`${s}\n`),
    color: process.stdout.isTTY === true && env.NO_COLOR === undefined,
  },
): Promise<number> {
  const args = [...argv]
  if (args[0] === 'doctor') args.shift()
  else if (args.length === 0 || args[0] === '-h' || args[0] === '--help' || args[0] === 'help') {
    io.out(USAGE)
    return args.length === 0 ? 2 : 0
  } else if (!args[0]?.startsWith('-')) {
    io.err(`Unknown command "${args[0]}".\n\n${USAGE}`)
    return 2
  }
  const o: DoctorOptions = { partnerKey: env.CLEAREDBY_PARTNER_KEY ?? '' }
  if (env.CLEAREDBY_BASE_URL) o.baseUrl = env.CLEAREDBY_BASE_URL
  if (env.CLEAREDBY_ORG_KEY) o.orgKey = env.CLEAREDBY_ORG_KEY
  let json = false
  let color = io.color === true
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string
    const [flag, inline] = a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined]
    const value = (): string => {
      const v = inline ?? args[++i]
      if (v === undefined || v === '') throw new Error(`${flag} needs a value`)
      return v
    }
    try {
      switch (flag) {
        case '--org': o.orgId = value(); break
        case '--url': o.executionUrl = value(); break
        case '--audience': o.audience = value(); break
        case '--full': o.full = true; break
        case '--wait': {
          const n = Number(value())
          if (!Number.isFinite(n) || n < 0) throw new Error('--wait needs a number of seconds')
          o.waitSeconds = n
          break
        }
        case '--base-url': o.baseUrl = value(); break
        case '--org-key': o.orgKey = value(); break
        case '--json': json = true; break
        case '--no-color': color = false; break
        case '-h': case '--help': io.out(USAGE); return 0
        default: throw new Error(`unknown option ${flag}`)
      }
    } catch (err) {
      io.err(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`)
      return 2
    }
  }
  if (!json) {
    io.out(`ClearedBy doctor: checking ${o.baseUrl ?? DEFAULT_BASE}${o.full ? ' (with the real flow; this can take a couple of minutes)' : ''}...`)
  }
  const report = await runDoctor(o)
  io.out(json ? JSON.stringify(report, null, 2) : `\n${formatDoctorReport(report, { color })}`)
  return report.ok ? 0 : 1
}
