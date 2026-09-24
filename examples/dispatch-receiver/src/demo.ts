// Offline demo: no ClearedBy account needed. Plays ClearedBy's side locally
// (a throwaway Ed25519 key standing in for the published key, the same
// signing conventions) and drives the receiver through:
//   1. a genuine cleared dispatch        → 200 executed
//   2. the same authorization, retried   → 409 already_executed (new attempt, new receipt)
//   3. a forged amount, validly HMAC'd   → 401 receipt_mismatch
//
//   pnpm demo

import { createHash, createPrivateKey, generateKeyPairSync, sign } from 'node:crypto'
import { signDispatchPayload, type DispatchEnvelope } from '@clearedby/sdk/dispatch'
import { canonicalJSON, receiptSigningHash, type AuthorizationReceipt } from '@clearedby/sdk/receipt'
import { createReceiver } from './receiver'

const SECRET = 'odsec_demo_secret'
const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer
const KEYS = { demo1: spki.subarray(spki.length - 32).toString('hex') }
const priv = createPrivateKey({ key: privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer, format: 'der', type: 'pkcs8' })
const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')

const params = { order: '1042', amount: 25, currency: 'GBP' }
const paramsHash = sha(canonicalJSON(params))

function mintReceipt(nonce: string): AuthorizationReceipt {
  const now = new Date()
  const unsigned: Omit<AuthorizationReceipt, 'sig'> = {
    v: 1, receipt_id: `01RCPT${nonce}`, work_item_id: '01DEMOITEM', issuer: 'clearedby', principal: 'org_demo',
    agent: null, action: 'refund.create', params, params_hash: paramsHash, policy: { id: 'pol_demo', version: 1 },
    context_hash: null, decision: 'cleared', decided_by: 'user:u_demo', audience: 'https://exec.demo.example',
    issued_at: now.toISOString(), expires_at: new Date(now.getTime() + 600_000).toISOString(),
    nonce, supersedes: '01RCPTORIGINAL', key_id: 'demo1', alg: 'ed25519',
  }
  return { ...unsigned, sig: sign(null, Buffer.from(receiptSigningHash(unsigned), 'utf8'), priv).toString('hex') }
}

function deliver(attempt: number, over: Partial<DispatchEnvelope> = {}): { body: string, headers: Record<string, string> } {
  const env: DispatchEnvelope = {
    v: 2, delivery_id: '01DEMOITEM:cleared', attempt, event: 'on_decision', verdict: 'cleared', org_id: 'org_demo',
    work_item_id: '01DEMOITEM', parent_item_id: null, action: 'refund.create', params, params_hash: paramsHash,
    decided_by: 'user:u_demo', rule: 'rules[1]', attestation: { seq: 1, hash: 'f'.repeat(64) },
    receipt: mintReceipt(`n${attempt}`), issued_at: new Date().toISOString(), ...over,
  }
  const body = JSON.stringify(env)
  const t = Math.floor(Date.now() / 1000)
  return { body, headers: { 'clearedby-signature': `t=${t},v1=${signDispatchPayload(SECRET, t, body)}`, 'clearedby-delivery-id': env.delivery_id } }
}

const handle = createReceiver(
  { secret: SECRET, keys: KEYS, audience: 'https://exec.demo.example' },
  async (action, p, id) => {
    console.log(`  -> executing ${action} ${JSON.stringify(p)} for ${id}`)
    return { ref: 're_demo_1' }
  },
)

const show = async (label: string, d: { body: string, headers: Record<string, string> }): Promise<void> => {
  const r = await handle(d.body, d.headers)
  console.log(`${label}: ${r.status} ${JSON.stringify(r.body)}`)
}

await show('1. first delivery', deliver(1))
await show('2. retry (attempt 2, fresh receipt)', deliver(2))
const forgedParams = { ...params, amount: 2500 }
await show('3. forged amount', deliver(3, { params: forgedParams, params_hash: sha(canonicalJSON(forgedParams)), work_item_id: '01OTHER' }))
