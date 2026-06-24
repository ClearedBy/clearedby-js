/**
 * Dogfood demo — a Shopify merchant's AI agent issues a refund through ClearedBy.
 *
 * This is the "overlap case" from docs/clearedby-adapters.md: same store, same
 * Core, a different *doer*. Instead of a Shopify Flow proposing the refund, the
 * merchant's own AI agent does — and ClearedBy gates it exactly the same way:
 *
 *     agent proposes  →  ClearedBy gates  →  a human approves / rejects / SENDS BACK
 *                                              │
 *            ┌── sent_back: agent revises ─────┘
 *            ▼
 *     agent resubmits (linked to the parent)  →  cleared  →  agent EXECUTES the
 *     refund against Shopify  →  records proof-of-execution into the audit chain.
 *
 * The whole point: the agent never decides for itself. Policy clears the safe
 * ones; a human handles the rest; the human can negotiate ("cap it at £100")
 * without rejecting outright; and every step — including the revise — is signed.
 *
 * Run it, then open the ClearedBy workspace and send the item back with a note
 * like "Goodwill cap is £100" — watch this script revise and resubmit, then get
 * approved and execute. See ./README.md.
 */
import { ClearedBy, RejectedError, type GateResult } from '@clearedby/sdk'

// ── config ──────────────────────────────────────────────────────────────────
const apiKey = process.env.CLEAREDBY_API_KEY
if (!apiKey) {
  console.error(
    'Set CLEAREDBY_API_KEY to an agent-bound key (cb_live_…) from ClearedBy → Settings → API keys.\n' +
      'Binding the key to an agent (CLE-141) is what makes the refund attributable to a verified doer.',
  )
  process.exit(1)
}
const cb = new ClearedBy({ apiKey, baseUrl: process.env.CLEAREDBY_BASE_URL })
const shop = process.env.SHOPIFY_SHOP ?? 'demo-store.myshopify.com'

// The order the agent is handling. In a real integration this comes from the
// Shopify Admin API / a Flow action payload; hard-coded here so the demo is
// self-contained.
const order = {
  gid: 'gid://shopify/Order/4567',
  name: 'SO-118',
  total: 400,
  currency: 'GBP',
  customer: 'a.popov@example.com',
}

// ── the agent's "brain" ───────────────────────────────────────────────────────
// In production `propose` and `revise` are LLM calls. Here they're deterministic
// so the demo runs offline and reproducibly — but the shape is the real one: the
// agent forms a proposal, and when a human pushes back it reads the note and
// forms a *new* proposal rather than giving up.
type Refund = { amount: number; reason: string }

function proposeRefund(o: typeof order): Refund {
  return { amount: o.total, reason: 'Customer reports the item arrived damaged; photos attached to the ticket.' }
}

function reviseRefund(current: Refund, reviewerNote: string): Refund {
  // A real agent re-prompts its model with the reviewer's note. We approximate
  // that: if the note names a cap, honour it; otherwise concede to half.
  const cap = parseMoney(reviewerNote)
  const amount = cap !== null ? Math.min(current.amount, cap) : Math.max(1, Math.round(current.amount / 2))
  return { amount, reason: `${current.reason} (Revised per reviewer: "${reviewerNote}".)` }
}

function parseMoney(s: string): number | null {
  const m = s.match(/(?:£|\$|€)?\s*(\d+(?:\.\d{1,2})?)/)
  return m ? Number(m[1]) : null
}

// ── where ClearedBy ends and Shopify begins ──────────────────────────────────
// The Core APPROVES; the doer EXECUTES. This is the only place the demo touches
// Shopify, and it's stubbed unless SHOPIFY_SHOP + SHOPIFY_ADMIN_TOKEN are set —
// the headline (the gate + revise loop) runs without a real store.
async function executeRefund(o: typeof order, amount: number): Promise<string> {
  const token = process.env.SHOPIFY_ADMIN_TOKEN
  if (!process.env.SHOPIFY_SHOP || !token) {
    return `simulated-refund:${o.name}:${amount}` // dry-run external ref
  }
  // A real implementation calls the Shopify Admin GraphQL `refundCreate` here and
  // returns the refund gid. Omitted to keep the example dependency-free; the
  // external ref below would be that gid.
  return `gid://shopify/Refund/REAL-${o.name}`
}

// ── the loop ──────────────────────────────────────────────────────────────────
const MAX_ATTEMPTS = 5

async function main() {
  console.log(`\n🤖 Support agent is handling order ${order.name} (${order.currency} ${order.total}) for ${order.customer}.`)
  let refund = proposeRefund(order)
  let parentItemId: string | undefined

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const verb = parentItemId ? 'resubmits (revised)' : 'proposes'
    console.log(`\n[attempt ${attempt}] Agent ${verb}: refund ${order.currency} ${refund.amount} — "${refund.reason}"`)

    const input = {
      action: 'refund.create',
      params: { order: order.name, order_gid: order.gid, amount: refund.amount, currency: order.currency },
      context: {
        adapter: 'shopify',
        shop,
        order_gid: order.gid,
        summary: `Refund ${order.currency} ${refund.amount} on ${order.name} (${order.customer})`,
        agent_id: 'support-agent',
        model: 'claude-opus-4-8',
      },
      // The agent's case for the refund — rendered as friendly evidence cards in
      // the reviewer's dossier (CLE-96/97). ClearedBy presents it to the human,
      // pins it tamper-evident to their decision, and never claims it's true.
      proof: {
        reason: refund.reason,
        confidence: 0.9,
        recommended_outcome: 'approve_refund',
        risk_flags: refund.amount >= order.total ? ['full_order_value'] : [],
        evidence: [
          { type: 'threshold', value: { label: 'Refund vs order total', value: refund.amount, limit: order.total, unit: '£' } },
          {
            type: 'entity',
            value: {
              name: order.customer,
              subtitle: `Order ${order.name}`,
              fields: [
                { label: 'Order total', value: `${order.currency} ${order.total}` },
                { label: 'Refund', value: `${order.currency} ${refund.amount}` },
              ],
              badges: [{ label: 'damaged item', tone: 'warn' }],
            },
          },
          {
            type: 'timeline',
            value: [
              { label: 'Delivered' },
              { label: 'Damage reported', detail: 'photos attached to the ticket' },
              { label: 'Refund requested' },
            ],
          },
          { type: 'source', value: { title: `Support ticket · ${order.name}`, snippet: refund.reason } },
          {
            type: 'conversation',
            value: {
              title: `Support thread · ${order.name}`,
              messages: [
                { from: 'customer', text: 'The item arrived damaged — the base is cracked.', at: 'Jun 10' },
                { from: 'agent', text: 'So sorry to hear that. Could you attach a photo?', at: 'Jun 10' },
                // a message can carry an image — the reviewer sees it inline in the bubble
                { from: 'customer', text: 'Here it is:', image: 'https://cdn.example.com/tickets/SO-118/damage.jpg', at: 'Jun 10' },
              ],
            },
          },
        ],
      },
    }

    const submitted = parentItemId ? await cb.resubmit(parentItemId, input) : await cb.gate(input)
    const result = await settle(submitted)

    if (result.status === 'cleared') {
      console.log(`✅ Cleared${attestation(result)} — agent executes the refund.`)
      const externalRef = await executeRefund(order, refund.amount)
      const proof = await cb.complete(result.id, {
        status: 'done',
        executedParams: { amount: refund.amount, currency: order.currency },
        externalRef,
        evidence: [{ type: 'shopify_refund', value: externalRef }],
      })
      console.log(`📜 Proof-of-execution recorded (tier ${proof.tier}${proof.diverged ? ', DIVERGED' : ''}) ref=${externalRef}`)
      console.log('\nDone — refund issued and proven, with the human sign-off on the chain.\n')
      return
    }

    if (result.status === 'sent_back') {
      console.log(`↩️  Sent back to revise: "${result.reason ?? '(no note)'}" — NOT a rejection.`)
      refund = reviseRefund(refund, result.reason ?? '')
      parentItemId = result.id // link the next attempt to this one (one lineage)
      continue
    }

    if (result.status === 'rejected') {
      console.log(`⛔ Rejected: "${result.reason ?? '(no reason)'}" — agent stands down. No refund issued.`)
      return
    }

    console.log(`⚠️  Unexpected status "${result.status}" — stopping.`)
    return
  }

  console.log(`\nGave up after ${MAX_ATTEMPTS} revise attempts without a decision the agent could satisfy.`)
}

/** Resolve a gate result to a terminal state, waiting for a human if it's held. */
async function settle(r: GateResult): Promise<GateResult> {
  if (r.status !== 'pending') return r
  console.log(`⏳ Held for a human (item ${r.id}). Open the ClearedBy workspace to decide…`)
  try {
    return await cb.wait(r.id, { timeoutMs: 15 * 60_000, pollMs: 3_000 })
  } catch {
    console.log(`   Still pending after the wait window — item ${r.id} stays open. Decide it, then re-run.`)
    process.exit(0)
  }
}

function attestation(r: GateResult): string {
  return r.attestation?.hash ? ` · attestation ${r.attestation.hash.slice(0, 8)}` : ''
}

main().catch((err) => {
  if (err instanceof RejectedError) {
    console.log(`⛔ Rejected: ${err.result.reason ?? 'no reason given'} — agent stands down.`)
    process.exit(0)
  }
  console.error('\nDemo failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
