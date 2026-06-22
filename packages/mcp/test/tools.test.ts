import { describe, expect, it } from 'vitest'
import { checkPolicy, getLedger, requestClearance } from '../src/tools'
import type { ClearedBy } from '@clearedby/sdk'

// A minimal ClearedBy stub — only the methods the tools call.
function stub(overrides: Partial<Record<string, any>>): ClearedBy {
  return {
    gate: async () => ({ id: 'wi', status: 'cleared' }),
    check: async () => ({ dry: true, verdict: 'auto', rule: 'rules[0]', sampled: false }),
    ledger: async () => ({ entries: [] }),
    wait: async () => ({ id: 'wi', status: 'cleared' }),
    ...overrides,
  } as unknown as ClearedBy
}

describe('request_clearance', () => {
  it('cleared → safe to proceed', async () => {
    const r = await requestClearance(stub({ gate: async () => ({ id: 'wi', status: 'cleared', attestation: { seq: 1, hash: 'abcdef1234' } }) }), { action: 'refund.create' })
    expect(r.structured.cleared).toBe(true)
    expect(r.text).toContain('Cleared')
    expect(r.text).toContain('abcdef12')
  })
  it('rejected → cleared:false + reason, not approval-shaped', async () => {
    const r = await requestClearance(stub({ gate: async () => ({ id: 'wi', status: 'rejected', reason: 'over limit' }) }), { action: 'refund.create' })
    expect(r.structured.cleared).toBe(false)
    expect(r.text).toContain('Rejected')
    expect(r.text).toContain('over limit')
  })
  it('pending → waits → cleared', async () => {
    const r = await requestClearance(
      stub({ gate: async () => ({ id: 'wi', status: 'pending' }), wait: async () => ({ id: 'wi', status: 'cleared' }) }),
      { action: 'refund.create' },
    )
    expect(r.structured.cleared).toBe(true)
    expect(r.text).toContain('Approved by a reviewer')
  })
  it('shadow → not blocking', async () => {
    const r = await requestClearance(stub({ gate: async () => ({ id: 'wi', status: 'cleared', shadow: true, would: { verdict: 'review', rule: 'r' } }) }), { action: 'x' })
    expect(r.structured.shadow).toBe(true)
    expect(r.text).toContain('Shadow')
  })
  it('sent_back (immediate) → revise & resubmit, NOT rejected', async () => {
    const r = await requestClearance(
      stub({ gate: async () => ({ id: 'wi', status: 'sent_back', reason: 'cap the refund at $100' }) }),
      { action: 'refund.create' },
    )
    expect(r.structured.cleared).toBe(false)
    expect(r.structured.sent_back).toBe(true)
    expect(r.structured.parent_item_id).toBe('wi')
    expect(r.text).toContain('Sent back')
    expect(r.text).toContain('parentItemId="wi"')
    expect(r.text).not.toContain('Rejected') // a send-back must never read as a rejection
  })
  it('pending → waits → sent_back surfaces the revise loop', async () => {
    const r = await requestClearance(
      stub({ gate: async () => ({ id: 'wi', status: 'pending' }), wait: async () => ({ id: 'wi', status: 'sent_back', reason: 'add a note' }) }),
      { action: 'refund.create' },
    )
    expect(r.structured.sent_back).toBe(true)
    expect(r.structured.parent_item_id).toBe('wi')
    expect(r.text).not.toContain('Rejected by a reviewer')
  })
  it('resubmit threads parentItemId into gate (one auditable lineage)', async () => {
    let seen: unknown
    const r = await requestClearance(
      stub({ gate: async (input: any) => { seen = input.parentItemId; return { id: 'wi2', status: 'cleared' } } }),
      { action: 'refund.create', parentItemId: 'wi' },
    )
    expect(seen).toBe('wi')
    expect(r.structured.cleared).toBe(true)
  })
})

describe('check_policy', () => {
  it('returns the dry-run verdict, persists nothing', async () => {
    const r = await checkPolicy(stub({}), { action: 'refund.create', params: { amount: 50 } })
    expect(r.text).toContain('auto')
    expect(r.text).toContain('Nothing was recorded')
  })
})

describe('get_ledger', () => {
  it('summarises recent entries', async () => {
    const r = await getLedger(stub({ ledger: async () => ({ entries: [{}, {}, {}] }) }), { limit: 3 })
    expect(r.text).toContain('3 recent attestations')
  })
})
