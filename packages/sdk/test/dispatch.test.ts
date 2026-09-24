// CLE-209 — verifyDispatch. Envelopes and receipts are produced in-test with an
// independent implementation of the issuer conventions (sorted-key JSON,
// Ed25519 over utf8(sha256_hex(...)), HMAC over "<t>.<body>"), so the suite
// proves the verifier against the protocol.

import { createHash, createHmac, createPrivateKey, generateKeyPairSync, sign as cryptoSign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { DispatchVerificationError, parseSignatureHeader, ReceiptRevokedError, verifyDispatch, type DispatchEnvelope } from '../src/dispatch'
import { RECEIPT_VERSION, type AuthorizationReceipt } from '../src/receipt'

const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer
const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer
const KEYS = { ed1: spki.subarray(spki.length - 32).toString('hex') }
const SECRET = 'odsec_test_secret'
const NOW = new Date('2026-09-23T12:00:00.000Z')
const T = Math.floor(NOW.getTime() / 1000)

function sortedStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(sortedStringify).join(',') + ']'
  return '{' + Object.keys(v as object).sort().map((k) => JSON.stringify(k) + ':' + sortedStringify((v as Record<string, unknown>)[k])).join(',') + '}'
}
const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')

const PARAMS = { amount: 25, currency: 'GBP', order: '1042' }
const PARAMS_HASH = sha(sortedStringify(PARAMS))

function receipt(over: Partial<AuthorizationReceipt> = {}): AuthorizationReceipt {
  const unsigned: Omit<AuthorizationReceipt, 'sig'> = {
    v: RECEIPT_VERSION,
    receipt_id: '01RECEIPT2',
    work_item_id: '01ITEM',
    issuer: 'clearedby',
    principal: 'org_1',
    agent: null,
    action: 'refund.create',
    params: PARAMS,
    params_hash: PARAMS_HASH,
    policy: { id: 'pol_1', version: 1 },
    context_hash: null,
    decision: 'cleared',
    decided_by: 'user:u_1',
    audience: 'https://exec.partner.example',
    issued_at: NOW.toISOString(),
    expires_at: new Date(NOW.getTime() + 600_000).toISOString(),
    nonce: 'd'.repeat(32),
    supersedes: '01RECEIPT1',
    key_id: 'ed1',
    alg: 'ed25519',
    ...over,
  }
  const hashHex = sha(sortedStringify(unsigned))
  const sig = cryptoSign(null, Buffer.from(hashHex, 'utf8'), createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' })).toString('hex')
  return { ...unsigned, sig }
}

function envelope(over: Partial<DispatchEnvelope> = {}): DispatchEnvelope {
  return {
    v: 2,
    delivery_id: '01ITEM:cleared',
    attempt: 2,
    event: 'on_decision',
    verdict: 'cleared',
    org_id: 'org_1',
    work_item_id: '01ITEM',
    parent_item_id: null,
    action: 'refund.create',
    params: PARAMS,
    params_hash: PARAMS_HASH,
    decided_by: 'user:u_1',
    rule: 'rules[0]',
    attestation: { seq: 7, hash: 'e'.repeat(64) },
    receipt: receipt(),
    issued_at: NOW.toISOString(),
    ...over,
  }
}

function signed(env: unknown, t = T, secret = SECRET): { body: string, headers: Record<string, string> } {
  const body = JSON.stringify(env)
  const v1 = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')
  return { body, headers: { 'clearedby-signature': `t=${t},v1=${v1}`, 'clearedby-delivery-id': (env as DispatchEnvelope).delivery_id } }
}

const opts = { secret: SECRET, keys: KEYS, audience: 'https://exec.partner.example', now: NOW }

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p
    return 'ok'
  } catch (err) {
    expect(err).toBeInstanceOf(DispatchVerificationError)
    return (err as DispatchVerificationError).code
  }
}

describe('verifyDispatch', () => {
  it('accepts a signed cleared envelope and returns the receipt params', async () => {
    const { body, headers } = signed(envelope())
    const v = await verifyDispatch(body, headers, opts)
    expect(v.envelope.work_item_id).toBe('01ITEM')
    expect(v.params).toEqual(PARAMS)
    expect(v.receipt?.supersedes).toBe('01RECEIPT1')
  })

  it('works with a fetch Headers object and case-insensitive plain headers', async () => {
    const { body, headers } = signed(envelope())
    await expect(verifyDispatch(body, new Headers(headers), opts)).resolves.toBeTruthy()
    const upper = { 'Clearedby-Signature': headers['clearedby-signature']! }
    await expect(verifyDispatch(body, upper, opts)).resolves.toBeTruthy()
  })

  it('enforces the timestamp tolerance (default 300s)', async () => {
    const stale = signed(envelope(), T - 301)
    expect(await code(verifyDispatch(stale.body, stale.headers, opts))).toBe('timestamp_out_of_tolerance')
    const edge = signed(envelope(), T - 299)
    expect(await code(verifyDispatch(edge.body, edge.headers, opts))).toBe('ok')
    const future = signed(envelope(), T + 400)
    expect(await code(verifyDispatch(future.body, future.headers, opts))).toBe('timestamp_out_of_tolerance')
    expect(await code(verifyDispatch(stale.body, stale.headers, { ...opts, toleranceSec: 600 }))).toBe('ok')
  })

  it('rejects a wrong secret, a missing or malformed header, and a replayed signature on a different body', async () => {
    const { body, headers } = signed(envelope())
    expect(await code(verifyDispatch(body, headers, { ...opts, secret: 'nope' }))).toBe('bad_signature')
    expect(await code(verifyDispatch(body, {}, opts))).toBe('missing_signature')
    expect(await code(verifyDispatch(body, { 'clearedby-signature': 'sha256=abc' }, opts))).toBe('malformed_signature')
    const other = JSON.stringify({ ...envelope(), attempt: 3 })
    expect(await code(verifyDispatch(other, headers, opts))).toBe('bad_signature')
  })

  it('accepts any of several secrets (receiver-side rotation)', async () => {
    const { body, headers } = signed(envelope())
    expect(await code(verifyDispatch(body, headers, { ...opts, secret: ['old', SECRET] }))).toBe('ok')
  })

  it('rejects tampered params even when re-signed with the HMAC secret', async () => {
    // Attacker holding the HMAC secret bumps the amount and fixes params_hash:
    // the Ed25519 receipt still binds the ORIGINAL params, so it fails.
    const params = { ...PARAMS, amount: 2500 }
    const env = envelope({ params, params_hash: sha(sortedStringify(params)) })
    const { body, headers } = signed(env)
    expect(await code(verifyDispatch(body, headers, opts))).toBe('receipt_mismatch')
    // Params changed but params_hash left alone: caught before the receipt.
    const lazy = signed(envelope({ params }))
    expect(await code(verifyDispatch(lazy.body, lazy.headers, opts))).toBe('params_hash_mismatch')
  })

  it('rejects a receipt for another work item, org or action', async () => {
    for (const r of [receipt({ work_item_id: '01OTHER' }), receipt({ principal: 'org_2' })]) {
      const { body, headers } = signed(envelope({ receipt: r }))
      expect(await code(verifyDispatch(body, headers, opts))).toBe('receipt_mismatch')
    }
    const { body, headers } = signed(envelope({ receipt: receipt({ action: 'payout.create' }) }))
    expect(await code(verifyDispatch(body, headers, opts))).toBe('receipt_invalid')
  })

  it('surfaces receipt failures (expired, audience) as receipt_invalid with the reason', async () => {
    const { body, headers } = signed(envelope())
    try {
      await verifyDispatch(body, headers, { ...opts, audience: 'https://someone.else' })
      expect.unreachable()
    } catch (err) {
      expect((err as DispatchVerificationError).code).toBe('receipt_invalid')
      expect((err as DispatchVerificationError).receiptReason).toBe('audience_mismatch')
    }
    const old = receipt({ issued_at: new Date(NOW.getTime() - 3_600_000).toISOString(), expires_at: new Date(NOW.getTime() - 3_000_000).toISOString() })
    const s = signed(envelope({ receipt: old }))
    expect(await code(verifyDispatch(s.body, s.headers, opts))).toBe('receipt_invalid')
  })

  it('requires a receipt + keys for cleared; not for other verdicts', async () => {
    const noReceipt = envelope()
    delete noReceipt.receipt
    const a = signed(noReceipt)
    expect(await code(verifyDispatch(a.body, a.headers, opts))).toBe('missing_receipt')
    const b = signed(envelope())
    expect(await code(verifyDispatch(b.body, b.headers, { secret: SECRET, now: NOW }))).toBe('no_keys')
    const rejected = envelope({ verdict: 'rejected', delivery_id: '01ITEM:rejected' })
    delete rejected.receipt
    const c = signed(rejected)
    const v = await verifyDispatch(c.body, c.headers, { secret: SECRET, now: NOW })
    expect(v.receipt).toBeNull()
    expect(v.params).toEqual(PARAMS)
  })

  it('checks the delivery-id header, org binding and envelope version', async () => {
    const { body, headers } = signed(envelope())
    expect(await code(verifyDispatch(body, { ...headers, 'clearedby-delivery-id': 'x:cleared' }, opts))).toBe('delivery_id_mismatch')
    expect(await code(verifyDispatch(body, headers, { ...opts, orgId: 'org_2' }))).toBe('org_mismatch')
    const v1 = signed({ ...envelope(), v: 1 })
    expect(await code(verifyDispatch(v1.body, v1.headers, opts))).toBe('unsupported_version')
  })

  it('fetches keys from jwksUrl', async () => {
    const f = (async () => ({ ok: true, status: 200, json: async () => ({ keys: [{ kid: 'ed1', publicKeyHex: KEYS.ed1 }] }) })) as unknown as typeof fetch
    const { body, headers } = signed(envelope())
    const v = await verifyDispatch(body, headers, { secret: SECRET, jwksUrl: 'https://keys.test/.well-known/clearedby-keys', fetch: f, now: NOW })
    expect(v.receipt?.receipt_id).toBe('01RECEIPT2')
  })

  it('parseSignatureHeader accepts multiple v1 values', () => {
    const p = parseSignatureHeader(`t=${T},v1=${'a'.repeat(64)},v1=${'b'.repeat(64)}`)
    expect(p).toEqual({ t: T, v1: ['a'.repeat(64), 'b'.repeat(64)] })
  })
})

// CLE-201 — the optional online "is it still valid?" check.
describe('verifyDispatch checkStatus', () => {
  const statusFetch = (answer: Record<string, unknown> | 'down', seen: string[] = []) =>
    (async (url: string) => {
      seen.push(String(url))
      if (answer === 'down') throw new Error('ECONNREFUSED')
      return { ok: true, status: 200, json: async () => answer }
    }) as unknown as typeof fetch

  it('is off by default: no status request is made', async () => {
    const seen: string[] = []
    const { body, headers } = signed(envelope())
    const v = await verifyDispatch(body, headers, { ...opts, fetch: statusFetch({ status: 'revoked' }, seen) })
    expect(v.receipt?.receipt_id).toBe('01RECEIPT2')
    expect(v.status).toBeUndefined()
    expect(seen).toEqual([])
  })

  it('rejects a revoked receipt with a typed ReceiptRevokedError', async () => {
    const seen: string[] = []
    const { body, headers } = signed(envelope())
    const f = statusFetch({ receipt_id: '01RECEIPT2', work_item_id: '01ITEM', status: 'revoked', revoked_at: '2026-09-23T12:01:00.000Z' }, seen)
    const err = await verifyDispatch(body, headers, { ...opts, fetch: f, checkStatus: true }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ReceiptRevokedError)
    expect(err).toBeInstanceOf(DispatchVerificationError)
    expect((err as ReceiptRevokedError).code).toBe('receipt_revoked')
    expect((err as ReceiptRevokedError).revokedAt).toBe('2026-09-23T12:01:00.000Z')
    expect(seen).toEqual(['https://app.clearedby.com/v1/receipts/01RECEIPT2/status'])
  })

  it('accepts valid / superseded / unknown / redacted answers and returns the status', async () => {
    for (const status of ['valid', 'superseded', 'unknown', 'redacted']) {
      const { body, headers } = signed(envelope())
      const v = await verifyDispatch(body, headers, { ...opts, fetch: statusFetch({ receipt_id: '01RECEIPT2', work_item_id: '01ITEM', status }), checkStatus: true })
      expect(v.status?.status).toBe(status)
    }
  })

  it('fails closed when the endpoint is unreachable or answers non-200', async () => {
    const { body, headers } = signed(envelope())
    expect(await code(verifyDispatch(body, headers, { ...opts, fetch: statusFetch('down'), checkStatus: true }))).toBe('status_unavailable')
    const f500 = (async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof fetch
    expect(await code(verifyDispatch(body, headers, { ...opts, fetch: f500, checkStatus: true }))).toBe('status_unavailable')
  })

  it('derives the status URL from jwksUrl, or uses an explicit statusUrl template', async () => {
    const seen: string[] = []
    const answer = { receipt_id: '01RECEIPT2', work_item_id: '01ITEM', status: 'valid' }
    const f = (async (url: string) => {
      seen.push(String(url))
      if (String(url).includes('clearedby-keys')) return { ok: true, status: 200, json: async () => ({ keys: [{ kid: 'ed1', publicKeyHex: KEYS.ed1 }] }) }
      return { ok: true, status: 200, json: async () => answer }
    }) as unknown as typeof fetch
    const a = signed(envelope())
    await verifyDispatch(a.body, a.headers, { secret: SECRET, jwksUrl: 'https://cb.test/.well-known/clearedby-keys', fetch: f, now: NOW, checkStatus: true })
    expect(seen).toContain('https://cb.test/v1/receipts/01RECEIPT2/status')
    const b = signed(envelope())
    await verifyDispatch(b.body, b.headers, { ...opts, fetch: f, checkStatus: { statusUrl: 'https://proxy.test/s/{receipt_id}' } })
    expect(seen).toContain('https://proxy.test/s/01RECEIPT2')
  })

  it('never checks status for non-cleared verdicts', async () => {
    const seen: string[] = []
    const { body, headers } = signed(envelope({ verdict: 'rejected', receipt: undefined }))
    await verifyDispatch(body, headers, { ...opts, fetch: statusFetch({ status: 'revoked' }, seen), checkStatus: true })
    expect(seen).toEqual([])
  })
})
