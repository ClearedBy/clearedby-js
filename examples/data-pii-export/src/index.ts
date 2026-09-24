/**
 * Fail-closed data governance under the `data-ops` policy. Unlike commerce
 * (where unknown actions default to review), data-ops defaults to REJECT and
 * defaults every human decision to a passkey — a fail-closed posture for PII.
 *
 * Four gate() calls, four outcomes:
 *   • non-PII export, small        → auto (cleared instantly)
 *   • PII export                   → dual_review + passkey (held for two people)
 *   • bulk delete (≥100 accounts)  → reject (policy block)
 *   • an unknown verb              → reject (unmatched default — fail closed)
 *
 *   CLEAREDBY_API_KEY=cb_live_… pnpm start
 */
import { ClearedBy, type GateResult } from '@clearedby/sdk'

const apiKey = process.env.CLEAREDBY_API_KEY
if (!apiKey) {
  console.error('Set CLEAREDBY_API_KEY (cb_live_…).')
  process.exit(1)
}
const cb = new ClearedBy({ apiKey, baseUrl: process.env.CLEAREDBY_BASE_URL })
const POLICY = 'data-ops'
const line = (label: string, r: GateResult) =>
  console.log(`  ${label.padEnd(34)} → ${r.status.padEnd(9)} ${r.status === 'pending' ? `(would ${r.rule})` : r.rule ?? ''}${r.reason ? ` — ${r.reason}` : ''}`)

async function gate(action: string, params: Record<string, unknown>, summary: string) {
  // The agent's case — a typed Proof Case (SDK 0.0.3) the reviewer sees as cards.
  return cb.gate({
    action,
    params,
    policy: POLICY,
    context: { agent_id: 'data-bot', summary },
    proof: {
      reason: summary,
      confidence: 0.9,
      recommended_outcome: 'approve',
      risk_flags: params.contains_pii === 1 ? ['contains_pii'] : [],
      evidence: [
        ...(typeof params.rows === 'number' ? [{ type: 'threshold' as const, value: { label: 'rows', value: params.rows as number, limit: 1000, status: (params.rows as number) > 1000 ? ('over' as const) : ('ok' as const) } }] : []),
        { type: 'entity' as const, value: { name: String(params.dataset ?? action), subtitle: action, badges: params.contains_pii === 1 ? [{ label: 'PII', tone: 'risk' as const }] : [] } },
      ],
    },
  })
}

async function main() {
  console.log('\ndata-ops — fail-closed governance\n')
  line('export 200 rows, no PII', await gate('data.export', { rows: 200, contains_pii: 0, dataset: 'orders' }, 'Export 200 order rows'))
  const pii = await gate('data.export', { rows: 5000, contains_pii: 1, dataset: 'customers' }, 'Export 5,000 customer rows (PII)')
  line('export 5,000 rows WITH PII', pii)
  line('delete 5,000 accounts', await gate('account.delete', { count: 5000 }, 'Bulk delete 5,000 accounts'))
  line('anonymize.run (unknown verb)', await gate('anonymize.run', {}, 'Run anonymizer'))

  if (pii.status === 'pending') {
    console.log(`\nThe PII export is held for DUAL review + a passkey. Approve it with two reviewers (one passkey):`)
    console.log(`  ${(process.env.CLEAREDBY_BASE_URL ?? 'https://app.clearedby.com')}/workspace?item=${pii.id}`)
  }
}

main().catch((err) => {
  console.error('failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
