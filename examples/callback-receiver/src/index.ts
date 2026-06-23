/**
 * Fire-and-forget — gate an action with a `callbackUrl` and DON'T block. ClearedBy
 * POSTs the verdict to your endpoint when a human decides (minutes or days later).
 * This one file is both sides: it submits a gated action, then runs a webhook
 * receiver that verifies the signature and acts on the verdict.
 *
 * Verification matters: anyone who guesses your callback URL could POST a fake
 * verdict, so every callback is signed. The gate response hands you the key
 * (`resume.signing_secret`) and each POST carries
 *   X-ClearedBy-Signature: sha256=hmac(secret, rawBody)
 *
 * Run:
 *   CLEAREDBY_API_KEY=cb_live_… PUBLIC_URL=https://<tunnel> pnpm start
 * ClearedBy must be able to reach PUBLIC_URL — locally, point it at an ngrok/
 * cloudflared tunnel to this port. See ./README.md.
 */
import { createServer } from 'node:http'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { ClearedBy } from '@clearedby/sdk'

const apiKey = process.env.CLEAREDBY_API_KEY
if (!apiKey) {
  console.error('Set CLEAREDBY_API_KEY (an agent-bound key, cb_live_…).')
  process.exit(1)
}
const cb = new ClearedBy({ apiKey, baseUrl: process.env.CLEAREDBY_BASE_URL })
const PORT = Number(process.env.PORT) || 4500
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}` // must be reachable by ClearedBy
const HOOK_PATH = '/hooks/clearedby'

let signingSecret = '' // learned from the gate response below

function verify(rawBody: string, header: string | undefined): boolean {
  if (header === undefined || signingSecret === '') return false
  const expected = 'sha256=' + createHmac('sha256', signingSecret).update(rawBody).digest('hex')
  // Constant-time compare; lengths must match first or timingSafeEqual throws.
  return header.length === expected.length && timingSafeEqual(Buffer.from(header), Buffer.from(expected))
}

// --- the receiver: verify, then act on the verdict ---
const server = createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== HOOK_PATH) {
    res.writeHead(404).end()
    return
  }
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    if (!verify(raw, req.headers['x-clearedby-signature'] as string | undefined)) {
      console.error('✗ bad/missing signature — ignoring this POST')
      res.writeHead(401).end('bad signature')
      return
    }
    const v = JSON.parse(raw) as { id: string; status: string; reason?: string | null }
    console.log(`✓ verified callback — ${v.status} (item ${v.id})`)
    if (v.status === 'cleared') console.log('   → safe to proceed: doing the work now (issue refund / send / etc.)')
    else if (v.status === 'rejected') console.log(`   → standing down: ${v.reason ?? ''}`)
    else if (v.status === 'sent_back') console.log(`   → revise & resubmit: ${v.reason ?? ''}`)
    res.writeHead(200).end('ok')
    server.close() // demo: one verdict and we're done
  })
})

// --- submit a gated action, then return (no blocking) ---
server.listen(PORT, async () => {
  console.log(`Receiver up on :${PORT}; ClearedBy will call ${PUBLIC_URL}${HOOK_PATH}`)
  const r = await cb.gate({
    action: 'refund.create',
    params: { amount: 250, order: 'SO-118', currency: 'GBP' },
    context: { agent_id: 'support-agent', proof: { confidence: 0.9, reason: 'damaged item, photos attached' } },
    callbackUrl: `${PUBLIC_URL}${HOOK_PATH}`,
  })
  signingSecret = r.resume?.signing_secret ?? ''
  console.log(`Gated → ${r.status}. Parked, holding no compute. Waiting for the verdict on the hook…`)
  if (r.status === 'cleared' || r.status === 'rejected') {
    console.log('(policy decided instantly — the hook may not fire; nothing to wait for)')
    server.close()
  }
})
