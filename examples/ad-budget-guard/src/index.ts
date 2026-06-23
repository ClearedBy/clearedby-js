/**
 * A marketing agent launches an ad campaign — gated by ClearedBy. Shows three
 * things the refund example doesn't:
 *   - a different action type (`ad.launch`) — the gate is domain-agnostic
 *   - `check()` first: a dry-run "what WOULD the policy do?", recording nothing
 *   - the poll pattern: submit, then `status()` on your own schedule (instead of
 *     blocking with guard()/wait() or parking on a callback)
 *
 * Run:  CLEAREDBY_API_KEY=cb_live_… pnpm start
 */
import { ClearedBy } from '@clearedby/sdk'

const apiKey = process.env.CLEAREDBY_API_KEY
if (!apiKey) {
  console.error('Set CLEAREDBY_API_KEY (an agent-bound key, cb_live_…).')
  process.exit(1)
}
const cb = new ClearedBy({ apiKey, baseUrl: process.env.CLEAREDBY_BASE_URL })

const campaign = { name: 'Summer Sale', dailyBudget: 800, channel: 'meta', objective: 'conversions' }

function launch() {
  console.log(`🚀 Launching "${campaign.name}" — £${campaign.dailyBudget}/day on ${campaign.channel}.`)
}

async function main() {
  console.log(`🤖 Ads agent wants to launch "${campaign.name}" at £${campaign.dailyBudget}/day.\n`)

  // 1. Dry-run: preview the policy verdict without recording anything. Great for
  //    a "would this need approval?" check before you commit to the flow.
  const dry = await cb.check({ action: 'ad.launch', params: { ...campaign } })
  console.log(`check(): policy would → ${dry.verdict} (rule ${dry.rule}). Nothing recorded.\n`)

  // 2. Gate for real.
  const r = await cb.gate({
    action: 'ad.launch',
    params: { ...campaign },
    context: { agent_id: 'ads-agent', model: 'claude-opus-4-8', proof: { confidence: 0.8, reason: 'within the Q3 paid plan; ROAS target 3.0' } },
  })

  if (r.status === 'cleared') {
    console.log('✅ Cleared by policy.')
    launch()
    return
  }
  if (r.status === 'rejected') {
    console.log(`⛔ Rejected: ${r.reason ?? ''}. Not launching.`)
    return
  }

  // 3. Held for a human. Poll on our own cadence rather than holding a request
  //    open. (For long waits, prefer a callbackUrl — see ../callback-receiver.)
  console.log(`⏳ Held for review (item ${r.id}). Polling every 3s — decide it in the workspace…`)
  for (;;) {
    await new Promise((res) => setTimeout(res, 3000))
    const s = await cb.status(r.id)
    if (s.status === 'cleared') {
      console.log('✅ Approved by a reviewer.')
      launch()
      return
    }
    if (s.status === 'rejected') {
      console.log(`⛔ Rejected: ${s.reason ?? ''}. Not launching.`)
      return
    }
    if (s.status === 'sent_back') {
      console.log(`↩️  Sent back to revise: ${s.reason ?? ''}. (Adjust the budget/targeting and resubmit.)`)
      return
    }
    console.log('   …still pending')
  }
}

main().catch((err) => {
  console.error('failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
