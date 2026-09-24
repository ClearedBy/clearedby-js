// Run the receiver as an HTTP server:
//
//   CLEAREDBY_SIGNING_SECRET=odsec_...  (or the org secret from GET /v1/signing-secrets)
//   CLEAREDBY_AUDIENCE=https://exec.you.example   (optional: what you pass as `audience` at gate time)
//   CLEAREDBY_EXECUTOR_KEY=cb_live_...  (optional: the org's executor key, to report completion)
//   pnpm start
//
// Serving several orgs (a partner): set CLEAREDBY_PARTNER_KEY instead of
// CLEAREDBY_SIGNING_SECRET and each org's secret is looked up (and cached) by
// the envelope's org_id. That is also what lets `npx @clearedby/sdk doctor`
// test it with its own sandbox org.
//
// Then point a policy at it:
//   on_decision:
//     cleared:
//       url: https://exec.you.example/on-decision
//       auth: exec-credential        # optional: signs with that credential's odsec_ secret
// or, as a partner: partner.updateSettings({ execution_url: 'https://exec.you.example/on-decision' })

import { createServer } from 'node:http'
import { ClearedBy, ClearedByPartner } from '@clearedby/sdk'
import { createReceiver, type ReceiverOptions } from './receiver'

const base = (process.env.CLEAREDBY_BASE_URL ?? 'https://app.clearedby.com').replace(/\/$/, '')
const partnerKey = process.env.CLEAREDBY_PARTNER_KEY
const secret = process.env.CLEAREDBY_SIGNING_SECRET
if (!secret && !partnerKey) throw new Error('set CLEAREDBY_SIGNING_SECRET (one org) or CLEAREDBY_PARTNER_KEY (all your orgs)')
const audience = process.env.CLEAREDBY_AUDIENCE
const executorKey = process.env.CLEAREDBY_EXECUTOR_KEY

const opts: ReceiverOptions = {}
if (partnerKey) {
  const partner = new ClearedByPartner({ partnerKey, baseUrl: base })
  const cache = new Map<string, Promise<string>>()
  opts.secretFor = (orgId) => {
    let s = cache.get(orgId)
    if (s === undefined) {
      s = partner.getSigningSecret(orgId)
      s.catch(() => cache.delete(orgId))
      cache.set(orgId, s)
    }
    return s
  }
}
if (executorKey) {
  const executor = new ClearedBy({ apiKey: executorKey, baseUrl: base })
  opts.complete = (id, input) => executor.complete(id, input)
}

const handle = createReceiver(
  {
    secret: secret ?? '',
    jwksUrl: `${base}/.well-known/clearedby-keys`,
    ...(audience ? { audience } : {}),
    checkStatus: true, // refuse approvals revoked after dispatch (do this for anything irreversible)
  },
  async (action, params, workItemId) => {
    // Your side effect goes here, driven ONLY by `params` (receipt-signed).
    console.log(`executing ${action} for ${workItemId}`, params)
    return { ref: `demo_${workItemId}` }
  },
  opts,
)

const port = Number(process.env.PORT ?? 8787)
createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/on-decision') {
    res.writeHead(404).end()
    return
  }
  // Read the RAW body: the signature is over these exact bytes.
  const chunks: Buffer[] = []
  req.on('data', (c: Buffer) => chunks.push(c))
  req.on('end', () => {
    handle(Buffer.concat(chunks).toString('utf8'), req.headers)
      .then(({ status, body }) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body)))
      .catch((err) => {
        console.error(err)
        res.writeHead(500).end()
      })
  })
}).listen(port, () => console.log(`dispatch receiver on http://localhost:${port}/on-decision`))
