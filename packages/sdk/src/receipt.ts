// @clearedby/sdk/receipt (CLE-200) — offline verification of ClearedBy
// Authorization Receipts. "Verify, don't trust": a relying party holding only
// a receipt and ClearedBy's published public keys can decide locally whether
// an agent is authorized — no ClearedBy API call, no account, no network
// dependency at decision time.
//
//   import { verifyReceipt, fetchClearedByKeys } from '@clearedby/sdk/receipt'
//
//   const keys = await fetchClearedByKeys()          // cache this
//   const v = verifyReceipt(receipt, { keys, audience: 'mcp://you.example.com' })
//   if (!v.valid) throw new Error(`unauthorized: ${v.reason}`)
//
// This module uses node:crypto (Ed25519), so it is Node 18+ only — that's why
// it lives on a subpath and not in the universal main entry. It is a verbatim
// port of the reference implementation in the ClearedBy monorepo
// (packages/core/src/receipt.ts + the canonical-JSON/Ed25519 primitives from
// packages/core/src/chain.ts); the signing convention is:
//
//   sig = ed25519(privKey, utf8(sha256_hex(canonicalJSON(receipt minus sig))))
//
// with key_id and alg INSIDE the signed bytes, so neither can be substituted.
//
// What a valid:true result does NOT cover (deliberately, documented):
//   - nonce replay: track seen nonces yourself for ~the TTL window;
//   - constraints beyond `action` equality: enforce your own ceilings
//     (e.g. params.amount) against the signed params;
//   - evidence truth: context_hash attests what ClearedBy EVALUATED, not
//     that the evidence is true.

import { createHash, createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto'

// ---- Canonical JSON (verbatim from @clearedby/core chain.ts) ----------------
// Deterministic JSON: object keys sorted recursively at every depth, arrays in
// order, no whitespace; JSON.stringify semantics otherwise. Byte-for-byte
// parity with the issuer is what makes the signature check meaningful.

export function canonicalJSON(value: unknown): string {
  const out = serialize(value, new Set())
  if (out === undefined) throw new TypeError('canonicalJSON: value has no JSON representation')
  return out
}

function serialize(raw: unknown, seen: Set<object>): string | undefined {
  let value = raw
  if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
    const toJSON = (value as { toJSON?: unknown }).toJSON
    if (typeof toJSON === 'function') {
      value = (toJSON as (key: string) => unknown).call(value, '')
    }
  }
  if (value === null) return 'null'
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value)
    case 'number':
      return JSON.stringify(value)
    case 'boolean':
      return value ? 'true' : 'false'
    case 'bigint':
      throw new TypeError('canonicalJSON: BigInt is not serializable')
    case 'undefined':
    case 'function':
    case 'symbol':
      return undefined
  }
  const obj = value as object
  if (seen.has(obj)) throw new TypeError('canonicalJSON: circular structure')
  seen.add(obj)
  let result: string
  if (Array.isArray(obj)) {
    const elements = obj as unknown[]
    const parts: string[] = []
    for (let i = 0; i < elements.length; i++) {
      parts.push(serialize(elements[i], seen) ?? 'null')
    }
    result = '[' + parts.join(',') + ']'
  } else {
    const parts: string[] = []
    for (const key of Object.keys(obj).sort()) {
      const member = serialize((obj as Record<string, unknown>)[key], seen)
      if (member !== undefined) parts.push(JSON.stringify(key) + ':' + member)
    }
    result = '{' + parts.join(',') + '}'
  }
  seen.delete(obj)
  return result
}

// ---- Ed25519 (raw 32-byte hex → KeyObject, RFC 8410 SPKI prefix) ------------

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
const RAW_KEY = /^[0-9a-fA-F]{64}$/

function publicKeyFromHex(hex: string): KeyObject {
  if (!RAW_KEY.test(hex)) throw new TypeError('expected 32 bytes of hex (64 chars)')
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(hex, 'hex')]),
    format: 'der',
    type: 'spki',
  })
}

function verifyHashEd25519(hashHex: string, signatureHex: string, publicKey: KeyObject): boolean {
  if (!/^[0-9a-fA-F]+$/.test(signatureHex) || signatureHex.length !== 128) return false
  try {
    return cryptoVerify(null, Buffer.from(hashHex, 'utf8'), publicKey, Buffer.from(signatureHex, 'hex'))
  } catch {
    return false
  }
}

// ---- Receipt types (mirror of the issuer's shape) ---------------------------

export const RECEIPT_VERSION = 1

/** The doer the receipt attests: a ClearedBy-registry-verified agent, or the
 *  caller's claim flagged verified:false. Treat unverified accordingly. */
export interface ReceiptAgent {
  id?: string
  principal: string
  verified: boolean
}

export interface AuthorizationReceipt {
  v: typeof RECEIPT_VERSION
  receipt_id: string
  work_item_id: string
  issuer: 'clearedby'
  /** The organization on whose behalf the action is authorized. */
  principal: string
  agent: ReceiptAgent | null
  action: string
  /** The EXACT decided params — enforce your own constraints against these. */
  params: Record<string, unknown>
  params_hash: string
  policy: { id: string, version: number, name?: string }
  /** What ClearedBy EVALUATED (proof case + evidence) — not evidence truth. */
  context_hash: string | null
  decision: 'cleared'
  decided_by: string
  /** The relying party this authorization names — null means unaddressed. */
  audience: string | null
  issued_at: string
  expires_at: string
  /** Replay handle: track seen nonces within the TTL. */
  nonce: string
  /**
   * Present only on a RE-ISSUED receipt: the receipt_id of the original one
   * minted at decide time. ClearedBy mints a fresh receipt for every
   * on_decision delivery attempt (same work item, params and decision; new
   * receipt_id, nonce and validity window), so a retry never carries an
   * expired receipt. Dedupe EXECUTION on `work_item_id`, never on the nonce.
   */
  supersedes?: string
  key_id: string
  alg: 'ed25519'
  sig: string
}

/** sha256 hex of the canonical JSON of the receipt WITHOUT `sig` — the exact
 *  message the signature covers. */
export function receiptSigningHash(unsigned: Omit<AuthorizationReceipt, 'sig'>): string {
  return createHash('sha256').update(canonicalJSON(unsigned), 'utf8').digest('hex')
}

/** key_id → raw 32-byte Ed25519 public hex (e.g. from fetchClearedByKeys). */
export type ReceiptKeys = Record<string, string> | ((keyId: string) => string | undefined)

export interface VerifyReceiptOptions {
  keys: ReceiptKeys
  /**
   * YOUR identity as the relying party. When set, the receipt must name
   * EXACTLY this audience — a receipt for someone else, or with no audience
   * at all, fails. Omit only if you deliberately accept unaddressed receipts
   * (weaker; don't for anything consequential).
   */
  audience?: string
  /** When set, receipt.action must equal exactly. */
  action?: string
  /** Clock override (tests); defaults to real time. */
  now?: Date
  /** Tolerated skew on issued_at/expires_at (default 30s). */
  clockSkewSeconds?: number
}

export type VerifyReceiptResult =
  | { valid: true, receipt: AuthorizationReceipt }
  | {
      valid: false,
      reason:
        | 'malformed'
        | 'unsupported_version'
        | 'unsupported_alg'
        | 'bad_decision'
        | 'unknown_key'
        | 'bad_signature'
        | 'not_yet_valid'
        | 'expired'
        | 'audience_mismatch'
        | 'action_mismatch',
    }

function isReceiptShaped(r: unknown): r is AuthorizationReceipt {
  if (r === null || typeof r !== 'object') return false
  const o = r as Record<string, unknown>
  const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0
  return (
    str(o.receipt_id) && str(o.work_item_id) && str(o.principal) &&
    str(o.action) && str(o.params_hash) && str(o.decided_by) &&
    str(o.issued_at) && str(o.expires_at) && str(o.nonce) &&
    str(o.key_id) && str(o.sig) &&
    (o.audience === null || str(o.audience)) &&
    (o.context_hash === null || str(o.context_hash)) &&
    typeof o.params === 'object' && o.params !== null && !Array.isArray(o.params) &&
    typeof o.policy === 'object' && o.policy !== null
  )
}

/**
 * Verify a receipt offline: signature, freshness, audience and action binding.
 * Checks run most-fundamental-first so `reason` names the earliest failure;
 * every content check after the signature reads signed fields only.
 */
export function verifyReceipt(receipt: unknown, opts: VerifyReceiptOptions): VerifyReceiptResult {
  if (!isReceiptShaped(receipt)) return { valid: false, reason: 'malformed' }
  if (receipt.v !== RECEIPT_VERSION) return { valid: false, reason: 'unsupported_version' }
  if (receipt.alg !== 'ed25519') return { valid: false, reason: 'unsupported_alg' }
  if (receipt.decision !== 'cleared' || receipt.issuer !== 'clearedby') {
    return { valid: false, reason: 'bad_decision' }
  }

  const publicHex = typeof opts.keys === 'function' ? opts.keys(receipt.key_id) : opts.keys[receipt.key_id]
  if (publicHex === undefined || publicHex === '') return { valid: false, reason: 'unknown_key' }
  let publicKey: KeyObject
  try {
    publicKey = publicKeyFromHex(publicHex)
  } catch {
    return { valid: false, reason: 'unknown_key' }
  }
  const { sig, ...unsigned } = receipt
  if (!verifyHashEd25519(receiptSigningHash(unsigned), sig, publicKey)) {
    return { valid: false, reason: 'bad_signature' }
  }

  const skewMs = (opts.clockSkewSeconds ?? 30) * 1000
  const now = (opts.now ?? new Date()).getTime()
  const issuedAt = Date.parse(receipt.issued_at)
  const expiresAt = Date.parse(receipt.expires_at)
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) return { valid: false, reason: 'malformed' }
  if (now < issuedAt - skewMs) return { valid: false, reason: 'not_yet_valid' }
  if (now > expiresAt + skewMs) return { valid: false, reason: 'expired' }

  if (opts.audience !== undefined && receipt.audience !== opts.audience) {
    return { valid: false, reason: 'audience_mismatch' }
  }
  if (opts.action !== undefined && receipt.action !== opts.action) {
    return { valid: false, reason: 'action_mismatch' }
  }
  return { valid: true, receipt }
}

// ---- Published-key discovery ------------------------------------------------

const DEFAULT_BASE = 'https://app.clearedby.com'

/**
 * Fetch ClearedBy's published verification keys (/.well-known/clearedby-keys)
 * as a `key_id → raw public hex` map for verifyReceipt. Accepts both the
 * document's `publicKeyHex` field and the JWKS-standard base64url `x`.
 *
 * Cache the result (keys rotate rarely); refetch when verifyReceipt returns
 * `unknown_key` — that's the rotation signal.
 */
export async function fetchClearedByKeys(
  opts: { baseUrl?: string, fetch?: typeof fetch } = {},
): Promise<Record<string, string>> {
  const f = opts.fetch ?? (globalThis.fetch as typeof fetch | undefined)
  if (!f) throw new Error('fetchClearedByKeys: no fetch available — pass options.fetch')
  const base = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/$/, '')
  const res = await f(`${base}/.well-known/clearedby-keys`)
  if (!res.ok) throw new Error(`fetchClearedByKeys: ${res.status} from ${base}`)
  const doc = (await res.json()) as { keys?: Array<{ kid?: string, publicKeyHex?: string, x?: string }> }
  const out: Record<string, string> = {}
  for (const k of doc.keys ?? []) {
    if (typeof k.kid !== 'string' || k.kid === '') continue
    if (typeof k.publicKeyHex === 'string' && k.publicKeyHex !== '') out[k.kid] = k.publicKeyHex
    else if (typeof k.x === 'string' && k.x !== '') out[k.kid] = Buffer.from(k.x, 'base64url').toString('hex')
  }
  return out
}

// ---- Online status check (CLE-201) --------------------------------------------
//
// verifyReceipt answers "is it AUTHENTIC?": signature, expiry, audience, action,
// all offline. It can't answer "is it still valid?": a cleared action can be
// REVOKED (POST /v1/gate/:id/revoke) before it runs. For anything irreversible
// (refunds, payouts, deletes) ask ClearedBy right before executing:
//
//   const v = await verifyReceiptOnline(receipt, { keys, audience, checkStatus: true })
//   if (!v.valid) throw new Error(`unauthorized: ${v.reason}`)   // 'revoked' included
//
// The status endpoint is public (no key): GET /v1/receipts/:receipt_id/status.
// Only `revoked` fails the check. `unknown` does NOT: a delivery can reach you a
// moment before the decision is committed, and an unknown receipt still has to
// pass the offline signature check to get here. `superseded` (a newer delivery
// receipt exists) and `redacted` (the item was erased) are not revocations.
// A network error or non-200 answer fails CLOSED (`status_unavailable`), since
// you only ask when you care.

export type ReceiptStatus = 'valid' | 'expired' | 'superseded' | 'revoked' | 'redacted' | 'unknown'

/** GET /v1/receipts/:receipt_id/status */
export interface ReceiptStatusView {
  receipt_id: string
  work_item_id: string | null
  status: ReceiptStatus
  expires_at?: string
  revoked_at?: string
  superseded_by?: string
}

export interface ReceiptStatusOptions {
  /**
   * The status URL. Either a template containing `{receipt_id}`, e.g.
   * `https://app.clearedby.com/v1/receipts/{receipt_id}/status` (the default,
   * built from `baseUrl`), or a base URL that `/v1/receipts/<id>/status` is appended to.
   */
  statusUrl?: string
  /** Defaults to https://app.clearedby.com (ignored when statusUrl is set). */
  baseUrl?: string
  fetch?: typeof fetch
}

/** `true` = ask the default ClearedBy endpoint; an object customizes it. */
export type CheckStatusOption = boolean | ReceiptStatusOptions

export function receiptStatusUrl(receiptId: string, opts: ReceiptStatusOptions = {}): string {
  const id = encodeURIComponent(receiptId)
  if (opts.statusUrl !== undefined && opts.statusUrl !== '') {
    return opts.statusUrl.includes('{receipt_id}')
      ? opts.statusUrl.replace('{receipt_id}', id)
      : `${opts.statusUrl.replace(/\/$/, '')}/v1/receipts/${id}/status`
  }
  return `${(opts.baseUrl ?? DEFAULT_BASE).replace(/\/$/, '')}/v1/receipts/${id}/status`
}

/** Thrown by checkReceiptStatus when the endpoint can't give an answer. */
export class ReceiptStatusUnavailableError extends Error {
  readonly code = 'status_unavailable' as const
  constructor(message: string) {
    super(message)
    this.name = 'ReceiptStatusUnavailableError'
  }
}

/** Ask ClearedBy whether a receipt is still valid. Throws ReceiptStatusUnavailableError. */
export async function checkReceiptStatus(receiptId: string, opts: ReceiptStatusOptions = {}): Promise<ReceiptStatusView> {
  const f = opts.fetch ?? (globalThis.fetch as typeof fetch | undefined)
  if (!f) throw new ReceiptStatusUnavailableError('checkReceiptStatus: no fetch available — pass options.fetch')
  let res: Response
  try {
    res = await f(receiptStatusUrl(receiptId, opts), { headers: { accept: 'application/json' } })
  } catch (err) {
    throw new ReceiptStatusUnavailableError(`receipt status request failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (res.status !== 200) throw new ReceiptStatusUnavailableError(`receipt status answered ${res.status}`)
  const body = (await res.json().catch(() => null)) as ReceiptStatusView | null
  if (body === null || typeof body.status !== 'string') throw new ReceiptStatusUnavailableError('receipt status answer is malformed')
  return body
}

export type VerifyReceiptOnlineResult =
  | { valid: true, receipt: AuthorizationReceipt, status?: ReceiptStatusView }
  | Extract<VerifyReceiptResult, { valid: false }>
  | { valid: false, reason: 'revoked', status: ReceiptStatusView }
  | { valid: false, reason: 'status_unavailable', error: string }

/**
 * verifyReceipt plus, when `checkStatus` is set, the online "is it still
 * valid?" check (see above). Offline checks run first; the network is only
 * touched for a receipt that is already authentic. `checkStatus` defaults to
 * false, so without it this is exactly verifyReceipt.
 */
export async function verifyReceiptOnline(
  receipt: unknown,
  opts: VerifyReceiptOptions & { checkStatus?: CheckStatusOption },
): Promise<VerifyReceiptOnlineResult> {
  const offline = verifyReceipt(receipt, opts)
  if (!offline.valid) return offline
  if (opts.checkStatus === undefined || opts.checkStatus === false) return offline
  const statusOpts = opts.checkStatus === true ? {} : opts.checkStatus
  let status: ReceiptStatusView
  try {
    status = await checkReceiptStatus(offline.receipt.receipt_id, statusOpts)
  } catch (err) {
    return { valid: false, reason: 'status_unavailable', error: err instanceof Error ? err.message : String(err) }
  }
  if (status.status === 'revoked') return { valid: false, reason: 'revoked', status }
  return { valid: true, receipt: offline.receipt, status }
}
