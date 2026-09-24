// Run the receiver as an HTTP server:
//
//   CLEAREDBY_SIGNING_SECRET=odsec_...  (or the org secret from GET /v1/signing-secrets)
//   CLEAREDBY_AUDIENCE=https://exec.you.example   (optional: what you pass as `audience` at gate time)
//   pnpm start
//
// Then point a policy at it:
//   on_decision:
//     cleared:
//       url: https://exec.you.example/on-decision
//       auth: exec-credential        # optional: signs with that credential's odsec_ secret

import { createServer } from 'node:http'
import { createReceiver } from './receiver'

const secret = process.env.CLEAREDBY_SIGNING_SECRET
if (!secret) throw new Error('set CLEAREDBY_SIGNING_SECRET')
const base = (process.env.CLEAREDBY_BASE_URL ?? 'https://app.clearedby.com').replace(/\/$/, '')
const audience = process.env.CLEAREDBY_AUDIENCE

const handle = createReceiver(
  {
    secret,
    jwksUrl: `${base}/.well-known/clearedby-keys`,
    ...(audience ? { audience } : {}),
  },
  async (action, params, workItemId) => {
    // Your side effect goes here, driven ONLY by `params` (receipt-signed).
    console.log(`executing ${action} for ${workItemId}`, params)
    return { ref: `demo_${workItemId}` }
  },
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
