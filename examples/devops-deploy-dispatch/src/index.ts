/**
 * Deploy gating under the `devops` policy, ending in an outbound DISPATCH:
 *   • staging deploy           → auto (string condition: env != 'production')
 *   • production deploy        → review; on approval the policy's
 *       on_decision.cleared CALLS your CI and CAPTURES the run id from the JSON
 *       response (extract: $.runId) → a TIER-3 "verifiable" completion, written
 *       automatically by ClearedBy (actor system:dispatch).
 *
 * The script gates and waits for the human; the dispatch + completion are
 * server-side, so afterwards we read the ledger back to show the captured run id.
 *
 *   CLEAREDBY_API_KEY=cb_live_… pnpm start
 *
 * NOTE: the completion only lands if the policy's on_decision URL is reachable.
 * Point devops.yaml's `REPLACE_PUBLIC_URL` at the deployed gallery's
 * /api/exec-receiver (which echoes a runId), or any JSON endpoint returning
 * `{ "runId": "…" }`.
 */
import { ClearedBy, type GateResult } from '@clearedby/sdk'

const apiKey = process.env.CLEAREDBY_API_KEY
if (!apiKey) {
  console.error('Set CLEAREDBY_API_KEY (an agent-bound deploy-bot key, cb_live_…).')
  process.exit(1)
}
const cb = new ClearedBy({ apiKey, baseUrl: process.env.CLEAREDBY_BASE_URL })
const BASE = process.env.CLEAREDBY_BASE_URL ?? 'https://app.clearedby.com'
const POLICY = 'devops'

async function main() {
  // 1) staging → auto.
  const staging = await cb.gate({ action: 'deploy.release', params: { env: 'staging', ref: 'abc123' }, policy: POLICY, context: { agent_id: 'deploy-bot', summary: 'Deploy abc123 to staging' } })
  console.log(`staging deploy → ${staging.status} (${staging.rule})`)

  // 2) production → review → dispatch on approval.
  const prod = await cb.gate({ action: 'deploy.release', params: { env: 'production', ref: 'def456' }, policy: POLICY, context: { agent_id: 'deploy-bot', summary: 'Deploy def456 to production' } })
  console.log(`production deploy → ${prod.status}`)
  let final: GateResult = prod
  if (prod.status === 'pending') {
    console.log(`⏳ Approve the prod deploy: ${BASE}/workspace?item=${prod.id}`)
    final = await cb.wait(prod.id, { timeoutMs: 15 * 60_000, pollMs: 3_000 }).catch(() => prod)
  }
  if (final.status !== 'cleared') {
    console.log(`prod deploy is ${final.status} — decide it, then re-run to see the dispatch.`)
    return
  }

  // 3) Read the ledger back for the auto-written dispatch completion.
  console.log('✅ Cleared — ClearedBy is calling CI. Reading the ledger for the captured run id…')
  await new Promise((r) => setTimeout(r, 2500))
  const led: any = await cb.ledger({ limit: 10 })
  const rows: any[] = led.entries ?? led.rows ?? []
  const comp = rows.find((e) => (e.work_item_id ?? e.payload?.work_item?.id) === final.id && e.kind === 'completion')
  if (comp) {
    const p = comp.payload ?? {}
    console.log(`📜 Tier ${p.tier ?? '?'} completion · actor ${comp.actor} · external_ref ${p.external_ref ?? '(none)'} ← captured run id`)
  } else {
    console.log('No completion yet — is the policy on_decision URL reachable + returning JSON { "runId": … }?')
  }
}

main().catch((err) => {
  console.error('failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
