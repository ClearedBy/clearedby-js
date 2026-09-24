// @clearedby/sdk/dispatch (CLE-209) — verify an on_decision dispatch before
// you execute it. For partners running an execution endpoint that receives
// ClearedBy's on_decision POST and then does something consequential
// (refund, discount, publish...).
//
//   import { verifyDispatch } from '@clearedby/sdk/dispatch'
//
//   const { envelope, params, receipt } = await verifyDispatch(rawBody, req.headers, {
//     secret: process.env.CLEAREDBY_SIGNING_SECRET!,   // odsec_... or GET /v1/signing-secrets
//     jwksUrl: 'https://app.clearedby.com/.well-known/clearedby-keys',
//     audience: 'https://exec.partner.example',        // if you asked for one at gate time
//   })
//   // execute ONLY from `params` (the receipt-signed params for cleared),
//   // deduping on envelope.work_item_id.
//
// What it checks, in order (each failure throws a DispatchVerificationError
// with a stable `code`):
//   1. `clearedby-signature: t=<unix>,v1=<hex>` is present and well-formed;
//   2. |now - t| <= toleranceSec (default 300): bounds replay of a captured POST;
//   3. HMAC-SHA256(secret, "<t>.<raw body>") matches a v1 (constant-time);
//   4. the body is a v2 envelope; params_hash == sha256(canonicalJSON(params));
//      the clearedby-delivery-id header (if sent) equals envelope.delivery_id;
//   5. cleared verdicts: the Ed25519 receipt verifies offline (signature,
//      freshness, audience, action) AND is bound to this envelope: same
//      work_item_id, org (principal), action and params_hash, with its own
//      params hashing to that params_hash;
//   6. OPTIONAL (checkStatus): the online "is it still valid?" check (CLE-201):
//      GET /v1/receipts/:receipt_id/status, rejecting a REVOKED authorization
//      (code 'receipt_revoked'). Off by default: 1-5 are fully offline. Turn it
//      on for anything irreversible (refunds, payouts): an approved action can
//      be revoked after the dispatch was sent, and only this check sees that.
//
// Node 18+ only (node:crypto), like @clearedby/sdk/receipt.

import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import {
  canonicalJSON,
  checkReceiptStatus,
  fetchClearedByKeys,
  verifyReceipt,
  type AuthorizationReceipt,
  type CheckStatusOption,
  type ReceiptKeys,
  type ReceiptStatusOptions,
  type ReceiptStatusView,
  type VerifyReceiptResult,
} from './receipt.js'

export const DISPATCH_ENVELOPE_VERSION = 2

export type DispatchVerdict = 'cleared' | 'rejected' | 'expired' | 'sent_back'

/** The v2 on_decision envelope (docs/dispatch-contract.md). */
export interface DispatchEnvelope {
  v: typeof DISPATCH_ENVELOPE_VERSION
  /** Stable per (work item, verdict) across retries and redeliveries. */
  delivery_id: string
  /** 1-based; increments on every retry / redeliver. */
  attempt: number
  event: 'on_decision'
  verdict: DispatchVerdict
  org_id: string
  /** The authorization's stable identity: dedupe execution on THIS. */
  work_item_id: string
  parent_item_id: string | null
  action: string
  params: Record<string, unknown>
  params_hash: string
  context_hash?: string
  decided_by: string | null
  rule: string | null
  reason?: string
  attestation: { seq: number | null, hash: string | null }
  /** Cleared verdicts only: a receipt minted for this attempt. */
  receipt?: AuthorizationReceipt
  issued_at: string
  /** The rendered policy `body` template, if the policy has one. */
  data?: unknown
}

export type DispatchErrorCode =
  | 'missing_signature'
  | 'malformed_signature'
  | 'timestamp_out_of_tolerance'
  | 'bad_signature'
  | 'malformed_envelope'
  | 'unsupported_version'
  | 'params_hash_mismatch'
  | 'delivery_id_mismatch'
  | 'org_mismatch'
  | 'missing_receipt'
  | 'receipt_invalid'
  | 'receipt_mismatch'
  | 'no_keys'
  /** CLE-201 (checkStatus): the authorization was revoked before execution. */
  | 'receipt_revoked'
  /** CLE-201 (checkStatus): the status endpoint couldn't answer, so we fail closed. */
  | 'status_unavailable'

export class DispatchVerificationError extends Error {
  readonly code: DispatchErrorCode
  /** Set when code === 'receipt_invalid': the verifyReceipt reason. */
  readonly receiptReason?: Extract<VerifyReceiptResult, { valid: false }>['reason']
  constructor(code: DispatchErrorCode, message: string, receiptReason?: Extract<VerifyReceiptResult, { valid: false }>['reason']) {
    super(message)
    this.name = 'DispatchVerificationError'
    this.code = code
    if (receiptReason !== undefined) this.receiptReason = receiptReason
  }
}

/**
 * CLE-201: thrown by verifyDispatch (with checkStatus) when the authorization
 * was REVOKED after approval. Do not execute. `code` is 'receipt_revoked'.
 */
export class ReceiptRevokedError extends DispatchVerificationError {
  readonly status: ReceiptStatusView
  readonly revokedAt: string | null
  constructor(status: ReceiptStatusView) {
    super('receipt_revoked', `the authorization for work item ${status.work_item_id ?? '?'} was revoked${status.revoked_at ? ` at ${status.revoked_at}` : ''}`)
    this.name = 'ReceiptRevokedError'
    this.status = status
    this.revokedAt = status.revoked_at ?? null
  }
}

/** Anything header-shaped: a fetch Headers, or Node's IncomingHttpHeaders / a plain object. */
export type HeadersLike = Headers | Record<string, string | string[] | undefined>

export interface VerifyDispatchOptions {
  /** The signing secret (credential odsec_..., or the org secret). Pass an
   *  array to accept several (e.g. during your own rotation). */
  secret: string | string[]
  /** key_id → Ed25519 public hex. Either this or jwksUrl is needed to verify
   *  cleared dispatches. */
  keys?: ReceiptKeys
  /** Full URL of ClearedBy's key document, e.g.
   *  https://app.clearedby.com/.well-known/clearedby-keys (fetched + cached 10 min). */
  jwksUrl?: string
  /** Your identity as relying party: the receipt must name exactly this. */
  audience?: string
  /** When set, envelope.org_id must equal it (bind to the one org you serve). */
  orgId?: string
  /** Max |now - t| in seconds (default 300). */
  toleranceSec?: number
  /** Clock override (tests). */
  now?: Date
  /** Custom fetch for jwksUrl (and the status check). */
  fetch?: typeof fetch
  /**
   * CLE-201: also ask ClearedBy whether the receipt was REVOKED
   * (GET /v1/receipts/:receipt_id/status) and throw ReceiptRevokedError if so.
   * Default false (fully offline). `true` uses the origin of `jwksUrl` when
   * given, else https://app.clearedby.com; pass `{ statusUrl }` to override.
   * Unreachable endpoint → 'status_unavailable' (fails closed).
   */
  checkStatus?: CheckStatusOption
}

export interface VerifiedDispatch {
  envelope: DispatchEnvelope
  /** What to execute. Cleared: the RECEIPT's signed params (identical to
   *  envelope.params, proven by hash). Other verdicts: envelope.params. */
  params: Record<string, unknown>
  /** The verified receipt (cleared verdicts), else null. */
  receipt: AuthorizationReceipt | null
  /** CLE-201: the status answer, when checkStatus was on (cleared verdicts). */
  status?: ReceiptStatusView
}

function statusOptionsFor(opts: VerifyDispatchOptions): ReceiptStatusOptions {
  const custom: ReceiptStatusOptions = typeof opts.checkStatus === 'object' ? opts.checkStatus : {}
  const fetchImpl = custom.fetch ?? opts.fetch
  if (custom.statusUrl !== undefined || custom.baseUrl !== undefined) {
    return { ...custom, ...(fetchImpl ? { fetch: fetchImpl } : {}) }
  }
  let baseUrl: string | undefined
  if (opts.jwksUrl !== undefined) {
    try {
      baseUrl = new URL(opts.jwksUrl).origin
    } catch {
      baseUrl = undefined
    }
  }
  return { ...(baseUrl ? { baseUrl } : {}), ...(fetchImpl ? { fetch: fetchImpl } : {}) }
}

function header(headers: HeadersLike, name: string): string | undefined {
  if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name) ?? undefined
  const h = headers as Record<string, string | string[] | undefined>
  const key = Object.keys(h).find((k) => k.toLowerCase() === name)
  const v = key === undefined ? undefined : h[key]
  return Array.isArray(v) ? v[0] : v
}

/** Parse `t=<unix>,v1=<hex>[,v1=<hex>]`. */
export function parseSignatureHeader(value: string): { t: number, v1: string[] } {
  let t: number | undefined
  const v1: string[] = []
  for (const part of value.split(',')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    const k = part.slice(0, i).trim()
    const v = part.slice(i + 1).trim()
    if (k === 't' && /^\d+$/.test(v)) t = Number(v)
    else if (k === 'v1' && /^[0-9a-f]{64}$/i.test(v)) v1.push(v.toLowerCase())
  }
  if (t === undefined || v1.length === 0) {
    throw new DispatchVerificationError('malformed_signature', 'clearedby-signature must be "t=<unix>,v1=<hex>"')
  }
  return { t, v1 }
}

/** hex HMAC-SHA256(secret, "<t>.<rawBody>") — the v1 signature. Exported for receivers' tests. */
export function signDispatchPayload(secret: string, t: number, rawBody: string): string {
  return createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')
}

const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')

function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex')
  const bb = Buffer.from(b, 'hex')
  return ba.length === bb.length && ba.length > 0 && timingSafeEqual(ba, bb)
}

const keyCache = new Map<string, { at: number, keys: Record<string, string> }>()
const KEY_CACHE_MS = 10 * 60_000

async function keysFromUrl(url: string, f: typeof fetch | undefined, now: number): Promise<Record<string, string>> {
  const hit = keyCache.get(url)
  if (hit !== undefined && now - hit.at < KEY_CACHE_MS) return hit.keys
  const suffix = '/.well-known/clearedby-keys'
  const baseUrl = url.endsWith(suffix) ? url.slice(0, -suffix.length) : url
  const keys = await fetchClearedByKeys({ baseUrl, ...(f ? { fetch: f } : {}) })
  keyCache.set(url, { at: now, keys })
  return keys
}

function isEnvelope(o: unknown): o is DispatchEnvelope {
  if (o === null || typeof o !== 'object' || Array.isArray(o)) return false
  const e = o as Record<string, unknown>
  const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0
  return (
    str(e.delivery_id) && typeof e.attempt === 'number' && e.event === 'on_decision' &&
    (e.verdict === 'cleared' || e.verdict === 'rejected' || e.verdict === 'expired' || e.verdict === 'sent_back') &&
    str(e.org_id) && str(e.work_item_id) && typeof e.action === 'string' && str(e.params_hash) &&
    typeof e.params === 'object' && e.params !== null && !Array.isArray(e.params) &&
    str(e.issued_at) && typeof e.attestation === 'object' && e.attestation !== null
  )
}

/**
 * Verify an on_decision v2 dispatch. `rawBody` MUST be the exact bytes
 * received (read the body as text before any JSON parsing). Throws
 * DispatchVerificationError; on success returns what to execute.
 */
export async function verifyDispatch(
  rawBody: string,
  headers: HeadersLike,
  opts: VerifyDispatchOptions,
): Promise<VerifiedDispatch> {
  const nowMs = (opts.now ?? new Date()).getTime()

  // 1-3: timestamped HMAC over "<t>.<raw body>".
  const sigHeader = header(headers, 'clearedby-signature')
  if (sigHeader === undefined || sigHeader === '') {
    throw new DispatchVerificationError('missing_signature', 'no clearedby-signature header (template-format deliveries use the legacy x-clearedby-signature)')
  }
  const { t, v1 } = parseSignatureHeader(sigHeader)
  const tolerance = opts.toleranceSec ?? 300
  if (Math.abs(nowMs / 1000 - t) > tolerance) {
    throw new DispatchVerificationError('timestamp_out_of_tolerance', `signature timestamp is more than ${tolerance}s from now`)
  }
  const secrets = Array.isArray(opts.secret) ? opts.secret : [opts.secret]
  const ok = secrets.some((s) => s !== '' && v1.some((sig) => safeEqualHex(signDispatchPayload(s, t, rawBody), sig)))
  if (!ok) throw new DispatchVerificationError('bad_signature', 'signature does not match the body for the given secret')

  // 4: envelope shape + internal consistency. Everything below reads signed bytes.
  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody)
  } catch {
    throw new DispatchVerificationError('malformed_envelope', 'body is not JSON')
  }
  if (parsed !== null && typeof parsed === 'object' && (parsed as { v?: unknown }).v !== DISPATCH_ENVELOPE_VERSION) {
    throw new DispatchVerificationError('unsupported_version', `expected envelope v${DISPATCH_ENVELOPE_VERSION}`)
  }
  if (!isEnvelope(parsed)) throw new DispatchVerificationError('malformed_envelope', 'body is not an on_decision v2 envelope')
  const envelope = parsed
  if (sha256Hex(canonicalJSON(envelope.params)) !== envelope.params_hash) {
    throw new DispatchVerificationError('params_hash_mismatch', 'params do not hash to params_hash')
  }
  const deliveryHeader = header(headers, 'clearedby-delivery-id')
  if (deliveryHeader !== undefined && deliveryHeader !== envelope.delivery_id) {
    throw new DispatchVerificationError('delivery_id_mismatch', 'clearedby-delivery-id header does not match the signed envelope')
  }
  if (opts.orgId !== undefined && envelope.org_id !== opts.orgId) {
    throw new DispatchVerificationError('org_mismatch', `dispatch is for org ${envelope.org_id}, expected ${opts.orgId}`)
  }

  if (envelope.verdict !== 'cleared') return { envelope, params: envelope.params, receipt: null }

  // 5: cleared: the receipt is the authorization. Verify it offline and bind it.
  if (envelope.receipt === undefined || envelope.receipt === null) {
    throw new DispatchVerificationError('missing_receipt', 'cleared dispatch carries no receipt (enforce-mode clears under an Ed25519 key always do)')
  }
  let keys: ReceiptKeys | undefined = opts.keys
  if (keys === undefined && opts.jwksUrl !== undefined) keys = await keysFromUrl(opts.jwksUrl, opts.fetch, nowMs)
  if (keys === undefined) throw new DispatchVerificationError('no_keys', 'pass `keys` or `jwksUrl` to verify cleared dispatches')

  const v = verifyReceipt(envelope.receipt, {
    keys,
    action: envelope.action,
    now: new Date(nowMs),
    ...(opts.audience !== undefined ? { audience: opts.audience } : {}),
  })
  if (!v.valid) throw new DispatchVerificationError('receipt_invalid', `receipt failed verification: ${v.reason}`, v.reason)
  const r = v.receipt
  if (
    r.work_item_id !== envelope.work_item_id ||
    r.principal !== envelope.org_id ||
    r.action !== envelope.action ||
    r.params_hash !== envelope.params_hash ||
    sha256Hex(canonicalJSON(r.params)) !== r.params_hash
  ) {
    throw new DispatchVerificationError('receipt_mismatch', 'receipt does not authorize this exact org + work item + action + params')
  }

  // 6 (optional): is it still valid? Only an authentic, bound receipt gets here.
  if (opts.checkStatus !== undefined && opts.checkStatus !== false) {
    let status: ReceiptStatusView
    try {
      status = await checkReceiptStatus(r.receipt_id, statusOptionsFor(opts))
    } catch (err) {
      throw new DispatchVerificationError('status_unavailable', `could not check the receipt status: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (status.status === 'revoked') throw new ReceiptRevokedError(status)
    return { envelope, params: r.params, receipt: r, status }
  }
  return { envelope, params: r.params, receipt: r }
}
