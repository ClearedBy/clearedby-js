/**
 * Finance dual-review — a *verified agent* moves money under finance-ops:
 *   1. a hard policy REJECT (wire over the ceiling) that no human can override;
 *   2. a large payout that needs DUAL_REVIEW + a PASSKEY signature;
 *   3. once two humans clear it, the agent executes and records TIER-3
 *      proof-of-execution (an external ref an auditor can verify at the source).
 *
 * Run with an AGENT-BOUND key (ClearedBy → Settings → Agents → mint a key) so
 * every call is attributed to a verified doer on the work item and the ledger —
 * not an unverified `agent_id` string:
 *
 *   CLEAREDBY_API_KEY=cb_live_… pnpm start
 *
 * Then open the workspace, and approve the payout with TWO reviewers, one
 * signing with a passkey. See ./README.md.
 */
import { ClearedBy, RejectedError, type GateResult, type ProofCase } from '@clearedby/sdk'

const apiKey = process.env.CLEAREDBY_API_KEY
if (!apiKey) {
  console.error('Set CLEAREDBY_API_KEY to an AGENT-BOUND key (cb_live_…) — that is what makes the doer verified.')
  process.exit(1)
}
const cb = new ClearedBy({ apiKey, baseUrl: process.env.CLEAREDBY_BASE_URL })
const POLICY = 'finance-ops'

const ctx = (summary: string) => ({ agent_id: 'payout-bot', model: 'claude-opus-4-8', summary })

// The agent's *case* for the payout — typed evidence cards (SDK 0.0.3) the
// reviewer sees as a friendly Proof Case panel, not raw JSON.
const payoutProof = (amount: number): ProofCase => ({
  reason: 'Q3 invoice INV-3092 approved by procurement; within the vendor contract.',
  confidence: 0.95,
  recommended_outcome: 'approve_payout',
  risk_flags: amount >= 25000 ? ['high_value'] : [],
  evidence: [
    { type: 'threshold', value: { label: 'Payout vs monthly cap', value: amount, limit: 50000, unit: '£', status: amount > 45000 ? 'warn' : 'ok' } },
    { type: 'entity', value: { name: 'acme-supplies', subtitle: 'Vendor · NET-30', fields: [{ label: 'Contract', value: 'C-2291' }], badges: [{ label: 'bank verified', tone: 'ok' }] } },
    { type: 'timeline', value: [{ label: 'Invoice received', at: '2026-06-20T09:00:00Z' }, { label: 'Procurement approved', at: '2026-06-23T14:00:00Z' }] },
    { type: 'source', value: { title: 'Invoice INV-3092', snippet: 'Q3 managed services — £40,000', verified: false } },
  ],
})

async function executePayout(amount: number): Promise<string> {
  // Your real transfer goes here (the bank / PSP holds its OWN credentials —
  // ClearedBy decides, your system executes). Stubbed to a fake ref.
  return `txn_${amount}_${Math.random().toString(36).slice(2, 10)}`
}

async function settle(r: GateResult): Promise<GateResult> {
  if (r.status !== 'pending') return r
  console.log(`⏳ Held (item ${r.id}). Open the workspace and approve with TWO reviewers — one with a passkey.`)
  console.log(`   ${(process.env.CLEAREDBY_BASE_URL ?? 'https://app.clearedby.com')}/workspace?item=${r.id}`)
  return cb.wait(r.id, { timeoutMs: 15 * 60_000, pollMs: 3_000 })
}

async function main() {
  // 1) A hard reject — wire.send ≥ £25,000 is policy-blocked. No review, no override.
  console.log('\n[1] Wiring £30,000 (over the ceiling)…')
  const blocked = await cb.gate({ action: 'wire.send', params: { amount: 30000, currency: 'GBP', beneficiary: 'offshore-ltd' }, policy: POLICY, context: ctx('Wire £30,000') })
  console.log(`    → ${blocked.status}${blocked.reason ? `: ${blocked.reason}` : ''}  (rule ${blocked.rule})`)

  // 2) The headline: a £40,000 payout → dual_review + passkey.
  console.log('\n[2] Proposing a £40,000 payout (needs two approvers + a passkey)…')
  const proposed = await cb.gate({ action: 'payout.create', params: { amount: 40000, currency: 'GBP', payee: 'acme-supplies' }, policy: POLICY, context: ctx('Payout £40,000 to acme-supplies — Q3 invoice'), proof: payoutProof(40000) })
  const final = await settle(proposed)

  if (final.status === 'rejected') {
    console.log(`⛔ Rejected: ${final.reason ?? ''}. Standing down.`)
    return
  }
  if (final.status !== 'cleared') {
    console.log(`Item is ${final.status} — decide it in the workspace, then re-run.`)
    return
  }

  // 3) Cleared by two humans → execute → record Tier-3 proof-of-execution.
  console.log(`✅ Cleared${final.attestation?.hash ? ` · ${final.attestation.hash.slice(0, 8)}` : ''}. Executing…`)
  const ref = await executePayout(40000)
  const proof = await cb.complete(final.id, {
    status: 'done',
    executedParams: { amount: 40000, currency: 'GBP', payee: 'acme-supplies' },
    externalRef: ref,
    evidence: [{ type: 'bank_transfer', value: ref }],
  })
  console.log(`📜 Proof recorded — Tier ${proof.tier}${proof.diverged ? ' (DIVERGED)' : ''} · ref ${ref}`)
  console.log('\nDone — a verified agent moved money, two humans signed off (one with a passkey), and the execution is proven on the chain.')
}

main().catch((err) => {
  if (err instanceof RejectedError) {
    console.log(`⛔ Rejected: ${err.result.reason ?? 'no reason'}.`)
    process.exit(0)
  }
  console.error('failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
