/**
 * Policy tour — dry-run check() one representative action per rule, across every
 * example policy, and print the verdict matrix. check() records NOTHING (no work
 * item, no attestation), so this is a safe way to confirm your policies are
 * activated and behaving before you wire up real gate() calls.
 *
 *   CLEAREDBY_API_KEY=cb_live_… pnpm start
 *
 * A policy that isn't activated yet shows an error on its row — activate it
 * (Policies → paste the YAML from clearedby-live-tester/policies → Activate).
 */
import { ClearedBy } from '@clearedby/sdk'

const apiKey = process.env.CLEAREDBY_API_KEY
if (!apiKey) {
  console.error('Set CLEAREDBY_API_KEY (a cb_live_… key from ClearedBy → Integrations).')
  process.exit(1)
}
const cb = new ClearedBy({ apiKey, baseUrl: process.env.CLEAREDBY_BASE_URL })

type Case = [action: string, params: Record<string, unknown>]
const TOUR: { policy: string; cases: Case[] }[] = [
  { policy: 'commerce-ops', cases: [['refund.create', { amount: 250 }], ['refund.create', { amount: 842 }], ['ad.launch', {}], ['mystery.verb', {}]] },
  { policy: 'finance-ops', cases: [['payout.create', { amount: 750 }], ['payout.create', { amount: 6000 }], ['payout.create', { amount: 40000 }], ['wire.send', { amount: 30000 }], ['treasury.rebalance', {}]] },
  { policy: 'marketing-ops', cases: [['email.send', { recipients: 2000 }], ['content.publish', { paid: 0 }], ['ad.launch', { dailyBudget: 200 }], ['promo.create', { percentOff: 40 }]] },
  { policy: 'data-ops', cases: [['data.export', { rows: 200, contains_pii: 0 }], ['data.export', { rows: 5000, contains_pii: 1 }], ['account.delete', { count: 5000 }], ['anonymize.run', {}]] },
  { policy: 'devops', cases: [['deploy.release', { env: 'staging' }], ['deploy.release', { env: 'production' }], ['infra.destroy', {}]] },
  { policy: 'banking-ops', cases: [['overdraft.extend', { amount: 300 }], ['overdraft.extend', { amount: 12000 }], ['overdraft.extend', { amount: 25000 }], ['spend_limit.raise', { increase: 8000 }]] },
  { policy: 'ops-approvals', cases: [['budget.approve', { amount: 500 }], ['budget.approve', { amount: 75000 }], ['contract.send', { value: 120000 }]] },
  { policy: 'support-ops', cases: [['ticket.close', {}], ['refund.create', { amount: 20 }], ['refund.create', { amount: 200 }]] },
  { policy: 'healthcare-ops', cases: [['prescription.issue', { controlled: 0 }], ['prescription.issue', { controlled: 1 }], ['record.access', { emergency: 1 }]] },
  { policy: 'hr-ops', cases: [['pto.approve', { days: 5 }], ['salary.change', { pctIncrease: 15 }], ['employee.offboard', {}]] },
  { policy: 'trust-safety', cases: [['post.remove', { reports: 5 }], ['account.ban', { permanent: 1 }], ['appeal.grant', {}]] },
  { policy: 'logistics-ops', cases: [['shipment.dispatch', { value: 500 }], ['inventory.writeoff', { amount: 2000 }]] },
  { policy: 'access-ops', cases: [['access.grant', { role: 'admin' }], ['access.grant', { role: 'viewer' }], ['prod.ssh', {}], ['provision.unknown', {}]] },
]

const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length))

for (const { policy, cases } of TOUR) {
  console.log(`\n# ${policy}`)
  for (const [action, params] of cases) {
    try {
      const r = await cb.check({ action, params, policy })
      console.log(`  ${pad(`${action} ${JSON.stringify(params)}`, 46)} → ${pad(r.verdict, 12)} ${r.rule}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.log(`  ${pad(`${action}`, 46)} → ERROR: ${msg}  (is "${policy}" activated?)`)
    }
  }
}
console.log('\nNothing was recorded — check() is a dry run.')
