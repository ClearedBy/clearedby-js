// CLE-200 — the SDK's offline receipt verifier. Self-contained: receipts are
// signed in-test with node:crypto Ed25519 using the exact issuer convention
// (sig over utf8(sha256_hex(canonicalJSON(receipt minus sig)))), so these
// tests prove the verifier against the protocol, not against a shared helper.

import { createHash, createPrivateKey, generateKeyPairSync, sign as cryptoSign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  checkReceiptStatus,
  fetchClearedByKeys,
  receiptSigningHash,
  receiptStatusUrl,
  verifyReceipt,
  verifyReceiptOnline,
  RECEIPT_VERSION,
  type AuthorizationReceipt,
} from '../src/receipt'

// ---- In-test issuer (independent implementation of the signing convention) --

const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer
const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer
const publicKeyHex = spki.subarray(spki.length - 32).toString('hex')
const KEYS = { ed1: publicKeyHex }

// Sorted-key stringify — a second, independent canonical-JSON implementation
// (recursive sort), so a divergence from the SDK's copy would fail the suite.
function sortedStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(sortedStringify).join(',') + ']'
  return (
    '{' +
    Object.keys(v as object)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + sortedStringify((v as Record<string, unknown>)[k]))
      .join(',') +
    '}'
  )
}

function signLikeIssuer(unsigned: Omit<AuthorizationReceipt, 'sig'>): string {
  const hashHex = createHash('sha256').update(sortedStringify(unsigned), 'utf8').digest('hex')
  return cryptoSign(null, Buffer.from(hashHex, 'utf8'), createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' })).toString('hex')
}

const NOW = new Date('2026-09-12T12:00:00.000Z')

function issue(over: Partial<AuthorizationReceipt> = {}): AuthorizationReceipt {
  const unsigned: Omit<AuthorizationReceipt, 'sig'> = {
    v: RECEIPT_VERSION,
    receipt_id: '01RECEIPT',
    work_item_id: '01ITEM',
    issuer: 'clearedby',
    principal: 'org_1',
    agent: { id: 'agt_1', principal: 'acme/refunder', verified: true },
    action: 'refund.create',
    params: { amount: 250, currency: 'GBP', order: '1042' },
    params_hash: 'a'.repeat(64),
    policy: { id: 'pol_1', version: 3, name: 'refunds' },
    context_hash: 'b'.repeat(64),
    decision: 'cleared',
    decided_by: 'user:u_1',
    audience: 'mcp://partner.example.com',
    issued_at: NOW.toISOString(),
    expires_at: new Date(NOW.getTime() + 600_000).toISOString(),
    nonce: 'c'.repeat(32),
    key_id: 'ed1',
    alg: 'ed25519',
    ...over,
  }
  return { ...unsigned, sig: signLikeIssuer(unsigned) }
}

describe('verifyReceipt', () => {
  it('verifies an issuer-convention receipt with only the public key', () => {
    const r = issue()
    const v = verifyReceipt(r, { keys: KEYS, audience: 'mcp://partner.example.com', action: 'refund.create', now: NOW })
    expect(v).toEqual({ valid: true, receipt: r })
  })

  it('signing-hash parity: SDK canonicalJSON matches the independent implementation', () => {
    const { sig, ...unsigned } = issue()
    const independent = createHash('sha256').update(sortedStringify(unsigned), 'utf8').digest('hex')
    expect(receiptSigningHash(unsigned)).toEqual(independent)
  })

  it.each([
    ['amount', (r: AuthorizationReceipt) => ({ ...r, params: { ...r.params, amount: 400 } })],
    ['audience', (r: AuthorizationReceipt) => ({ ...r, audience: 'mcp://attacker.example.com' })],
    ['expiry', (r: AuthorizationReceipt) => ({ ...r, expires_at: new Date(NOW.getTime() + 86_400_000).toISOString() })],
    ['key_id (substitution)', (r: AuthorizationReceipt) => ({ ...r, key_id: 'ed1', alg: 'ed25519' as const, sig: r.sig, action: 'payout.create' })],
  ])('tampered %s reads as bad_signature', (_n, mutate) => {
    expect(verifyReceipt(mutate(issue()), { keys: KEYS, now: NOW })).toEqual({ valid: false, reason: 'bad_signature' })
  })

  it('expired and not-yet-valid respect the skew window', () => {
    const r = issue()
    expect(verifyReceipt(r, { keys: KEYS, now: new Date(NOW.getTime() + 600_000 + 31_000) })).toEqual({ valid: false, reason: 'expired' })
    expect(verifyReceipt(r, { keys: KEYS, now: new Date(NOW.getTime() - 31_000) })).toEqual({ valid: false, reason: 'not_yet_valid' })
    expect(verifyReceipt(r, { keys: KEYS, now: new Date(NOW.getTime() + 600_000 + 29_000) }).valid).toBe(true)
  })

  it('a named verifier rejects other-audience AND no-audience receipts', () => {
    expect(verifyReceipt(issue(), { keys: KEYS, audience: 'mcp://other.example.com', now: NOW })).toEqual({ valid: false, reason: 'audience_mismatch' })
    expect(verifyReceipt(issue({ audience: null }), { keys: KEYS, audience: 'mcp://partner.example.com', now: NOW })).toEqual({ valid: false, reason: 'audience_mismatch' })
  })

  it('guards: junk, unknown key, wrong version, wrong alg, non-cleared decision', () => {
    expect(verifyReceipt(null, { keys: KEYS, now: NOW })).toEqual({ valid: false, reason: 'malformed' })
    expect(verifyReceipt({ ...issue(), key_id: 'ed9' }, { keys: KEYS, now: NOW })).toEqual({ valid: false, reason: 'unknown_key' })
    expect(verifyReceipt({ ...issue(), v: 2 }, { keys: KEYS, now: NOW })).toEqual({ valid: false, reason: 'unsupported_version' })
    expect(verifyReceipt({ ...issue(), alg: 'hmac-sha256' }, { keys: KEYS, now: NOW })).toEqual({ valid: false, reason: 'unsupported_alg' })
    expect(verifyReceipt({ ...issue(), decision: 'rejected' }, { keys: KEYS, now: NOW })).toEqual({ valid: false, reason: 'bad_decision' })
  })
})

describe('fetchClearedByKeys', () => {
  it('maps kid → hex from publicKeyHex and from JWKS base64url x', async () => {
    const x = Buffer.from(publicKeyHex, 'hex').toString('base64url')
    const f = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ keys: [{ kid: 'ed1', publicKeyHex }, { kid: 'ed2', x }, { kid: '' }, {}] }),
    })) as unknown as typeof fetch
    const keys = await fetchClearedByKeys({ fetch: f })
    expect(keys).toEqual({ ed1: publicKeyHex, ed2: publicKeyHex })
  })

  it('throws on a non-OK response', async () => {
    const f = (async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch
    await expect(fetchClearedByKeys({ fetch: f })).rejects.toThrow('503')
  })
})


// CLE-201 — verifyReceiptOnline: offline first, then the optional status check.
describe('verifyReceiptOnline (CLE-201)', () => {
  const answer = (status: string, extra: Record<string, unknown> = {}) =>
    (async (url: string) => ({ ok: true, status: 200, url, json: async () => ({ receipt_id: '01RECEIPT', work_item_id: '01ITEM', status, ...extra }) })) as unknown as typeof fetch

  it('without checkStatus is exactly verifyReceipt (no network)', async () => {
    let called = false
    const f = (async () => { called = true; throw new Error('no') }) as unknown as typeof fetch
    const v = await verifyReceiptOnline(issue(), { keys: KEYS, now: NOW, checkStatus: false, ...({ fetch: f } as object) })
    expect(v.valid).toBe(true)
    expect(called).toBe(false)
  })

  it('rejects a revoked receipt', async () => {
    const v = await verifyReceiptOnline(issue(), { keys: KEYS, now: NOW, checkStatus: { fetch: answer('revoked', { revoked_at: '2026-09-12T12:01:00.000Z' }) } })
    expect(v.valid).toBe(false)
    if (!v.valid) expect(v.reason).toBe('revoked')
  })

  it('accepts valid / superseded / unknown, and fails closed when unreachable', async () => {
    for (const s of ['valid', 'superseded', 'unknown']) {
      const v = await verifyReceiptOnline(issue(), { keys: KEYS, now: NOW, checkStatus: { fetch: answer(s) } })
      expect(v.valid).toBe(true)
      if (v.valid) expect(v.status?.status).toBe(s)
    }
    const down = (async () => { throw new Error('ECONNRESET') }) as unknown as typeof fetch
    const v = await verifyReceiptOnline(issue(), { keys: KEYS, now: NOW, checkStatus: { fetch: down } })
    expect(v.valid).toBe(false)
    if (!v.valid) expect(v.reason).toBe('status_unavailable')
  })

  it('never asks about a receipt that fails offline', async () => {
    let called = false
    const f = (async () => { called = true; return { ok: true, status: 200, json: async () => ({ status: 'valid' }) } }) as unknown as typeof fetch
    const v = await verifyReceiptOnline({ ...issue(), sig: '0'.repeat(128) }, { keys: KEYS, now: NOW, checkStatus: { fetch: f } })
    expect(v.valid).toBe(false)
    if (!v.valid) expect(v.reason).toBe('bad_signature')
    expect(called).toBe(false)
  })

  it('builds status URLs from baseUrl or a template', async () => {
    expect(receiptStatusUrl('01R')).toBe('https://app.clearedby.com/v1/receipts/01R/status')
    expect(receiptStatusUrl('01R', { baseUrl: 'https://x.test/' })).toBe('https://x.test/v1/receipts/01R/status')
    expect(receiptStatusUrl('01R', { statusUrl: 'https://p.test/r/{receipt_id}/s' })).toBe('https://p.test/r/01R/s')
    const got = await checkReceiptStatus('01RECEIPT', { fetch: answer('valid') })
    expect(got.status).toBe('valid')
  })
})
