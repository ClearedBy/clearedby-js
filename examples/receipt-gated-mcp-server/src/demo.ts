/**
 * End-to-end demo of the receipt loop, runnable with nothing but an API key:
 *
 *   CLEAREDBY_API_KEY=cb_live_… pnpm demo
 *
 *   AGENT side (holds the ClearedBy key)          PARTNER side (holds NO key)
 *   ─────────────────────────────────────         ─────────────────────────────
 *   1. gate refund.create, audience=partner
 *      → signed Authorization Receipt
 *                                                 2. verifyReceipt() locally
 *                                                    (published keys only)
 *                                                 3. execute per SIGNED params
 *                                                    → execution proof
 *   4. record completion on the ledger
 *      (authorized → executed → matched)
 *
 * Then it proves the enforcement is real: a tampered receipt (amount bumped
 * 250 → 400) is refused as bad_signature, and replaying the genuine receipt
 * is refused on its nonce. The partner runs as an actual MCP server — the
 * demo talks to it over an in-memory MCP transport; `pnpm start` serves the
 * same server over stdio for a real MCP client.
 *
 * If the gate holds the action for review, approve it in the ClearedBy
 * workspace — the demo waits. If no receipt comes back, your deploy is in
 * shadow mode or signing with HMAC (receipts need an Ed25519 signer).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ClearedBy, type AuthorizationReceipt } from '@clearedby/sdk'
import { fetchClearedByKeys } from '@clearedby/sdk/receipt'
import { buildPartnerServer } from './server.js'

const AUDIENCE = 'mcp://partner-billing.example'

const apiKey = process.env.CLEAREDBY_API_KEY
if (!apiKey) {
  console.error('Set CLEAREDBY_API_KEY (cb_live_…).')
  process.exit(1)
}
const cb = new ClearedBy({ apiKey, baseUrl: process.env.CLEAREDBY_BASE_URL })

async function callIssueRefund(client: Client, receipt: unknown): Promise<{ ok: boolean, text: string }> {
  const res = await client.callTool({ name: 'issue_refund', arguments: { receipt } })
  const first = Array.isArray(res.content) ? res.content[0] : undefined
  const text = first?.type === 'text' ? first.text : JSON.stringify(res.content)
  return { ok: res.isError !== true, text }
}

async function main() {
  // ---- AGENT: request authorization, naming the partner as the audience ----
  console.log(`[agent]   gating refund.create for audience ${AUDIENCE} …`)
  let r = await cb.gate({
    action: 'refund.create',
    params: { amount: 250, currency: 'GBP', order: 'SO-441' },
    audience: AUDIENCE,
    proof: {
      reason: 'Customer returned a damaged lamp; refund per policy.',
      confidence: 0.92,
      recommended_outcome: 'approve_refund',
    },
  })
  if (r.status === 'pending') {
    console.log(`[agent]   held for review (item ${r.id}) — approve it in the ClearedBy workspace; waiting…`)
    r = await cb.wait(r.id, { timeoutMs: 10 * 60 * 1000 })
  }
  if (r.status !== 'cleared') {
    console.error(`[agent]   not authorized (${r.status}${r.reason ? `: ${r.reason}` : ''}) — nothing to execute.`)
    process.exit(1)
  }
  const receipt = r.receipt as AuthorizationReceipt | undefined
  if (!receipt) {
    console.error('[agent]   cleared, but no receipt — the gate is in shadow mode or signing with HMAC (receipts need an Ed25519 signer).')
    process.exit(1)
  }
  console.log(`[agent]   cleared — receipt ${receipt.receipt_id} (expires ${receipt.expires_at})`)

  // ---- PARTNER: a real MCP server that holds only the PUBLISHED keys ----
  const keys = await fetchClearedByKeys({ baseUrl: process.env.CLEAREDBY_BASE_URL })
  const { server, executed } = buildPartnerServer({ audience: AUDIENCE, keys })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'demo-agent', version: '0.0.1' })
  await client.connect(clientTransport)

  // 1) The genuine receipt → verified locally, executed per the SIGNED params.
  const genuine = await callIssueRefund(client, receipt)
  console.log(`[partner] genuine receipt   → ${genuine.ok ? 'EXECUTED' : 'refused'}: ${genuine.text}`)
  if (!genuine.ok) process.exit(1)

  // 2) A tampered receipt (amount 250 → 400) → the signature breaks.
  const tampered = { ...receipt, params: { ...receipt.params, amount: 400 } }
  const forged = await callIssueRefund(client, tampered)
  console.log(`[partner] tampered (400)    → ${forged.ok ? 'EXECUTED (BUG!)' : forged.text}`)

  // 3) Replaying the genuine receipt → refused on the nonce.
  const replay = await callIssueRefund(client, receipt)
  console.log(`[partner] replayed receipt  → ${replay.ok ? 'EXECUTED (BUG!)' : replay.text}`)

  // ---- AGENT: close the loop — authorized → executed → matched ----
  const done = executed[0]
  if (done) {
    await cb.complete(r.id, {
      status: 'done',
      executedParams: { amount: done.amount, currency: done.currency, order: done.order },
      externalRef: done.external_ref,
    })
    console.log(`[agent]   completion recorded on the ledger (${done.external_ref}) — authorized → executed → matched.`)
  }
  if (forged.ok || replay.ok) process.exit(1)
  console.log('\nThe partner decided all three calls with no ClearedBy API call and no API key — only the receipt and the published public keys.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
