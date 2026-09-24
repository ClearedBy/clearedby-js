// CLE-222: type-level checks. These compile under `pnpm typecheck` (the test
// dir is in tsconfig); the runtime assertions just keep vitest happy.
import { describe, expect, expectTypeOf, it } from 'vitest'
import type {
  ApprovalRulesSettings,
  CreateOrgInput,
  GateContext,
  GateInput,
  ReviewerInput,
  UpdateOrgInput,
} from '../src/index'
import { ClearedByApiError, ClearedByError } from '../src/index'

describe('documented types', () => {
  it('ApprovalRulesSettings has spot_checks / spot_check_pct', () => {
    const s = {
      tags_auto_max_products: 200,
      inventory_auto_max_items: 50,
      price_changes: 'always_review',
      price_drop_review_pct: 30,
      discounts: 'always_review',
      refund_auto_max: 25,
      refund_dual_above: 250,
      refund_daily_auto_cap: 250,
      refund_per_order_cap: 25,
      order_cancel: 'always_review',
      timeout_hours: 72,
      spot_checks: false,
      spot_check_pct: 5,
    } satisfies ApprovalRulesSettings
    expectTypeOf<ApprovalRulesSettings['spot_checks']>().toEqualTypeOf<boolean>()
    expectTypeOf<ApprovalRulesSettings['spot_check_pct']>().toEqualTypeOf<number>()
    const patch: Partial<ApprovalRulesSettings> = { spot_checks: true, spot_check_pct: 10 }
    expect(s.spot_checks).toBe(false)
    expect(patch.spot_check_pct).toBe(10)
  })

  it('GateInput takes on_decision, reverts, audience, callback_url and timeout', () => {
    const input = {
      action: 'shopify.refund.create',
      params: { amount: 20 },
      context: {
        subject_id: 'gid://shopify/Customer/1',
        batch_id: 'b_77',
        requested_by_subject: 'user_17',
        summary: 'Refund #1001',
        anything_else: { ok: true },
      },
      audience: 'mcp://billing.example.com',
      callbackUrl: 'https://you.example/hook',
      callback_url: 'https://you.example/hook',
      timeout: '1h',
      reverts: 'wi_0',
      onDecision: { cleared: { url: 'https://exec.example' } },
      on_decision: { rejected: { url: 'https://n.example' }, expired: { url: 'https://n.example' }, sent_back: { url: 'https://n.example' } },
    } satisfies GateInput
    expectTypeOf<GateInput['timeout']>().toEqualTypeOf<number | string | undefined>()
    expectTypeOf<GateContext['subject_id']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<GateContext['batch_id']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<GateContext['requested_by_subject']>().toEqualTypeOf<string | undefined>()
    // @ts-expect-error an on_decision override is only a URL (no credentials)
    const bad: GateInput = { action: 'a', on_decision: { cleared: { url: 'https://x', secret: 's' } } }
    expect(input.reverts).toBe('wi_0')
    expect(bad.action).toBe('a')
  })

  it('partner inputs accept the documented fields', () => {
    const create = { external_id: 'shop_1', name: 'Acme', currency: 'GBP', shop_domains: ['acme.myshopify.com'] } satisfies CreateOrgInput
    const update = { execution_url: null, notify_url: 'https://n.example', theme: null, shop_domains: [] } satisfies UpdateOrgInput
    const reviewer = { display_name: 'Sam', role: 'admin', authority: { '*': 10000 }, channels: ['slack'] } satisfies ReviewerInput
    expect([create.name, update.theme, reviewer.role]).toEqual(['Acme', null, 'admin'])
  })

  it('ClearedByError is the same class as ClearedByApiError', () => {
    expect(ClearedByError).toBe(ClearedByApiError)
    expectTypeOf<ClearedByError>().toEqualTypeOf<ClearedByApiError>()
    const e = new ClearedByApiError('m', 400, 'invalid_body', { error: { code: 'invalid_body', message: 'm', details: { a: 1 } } })
    expectTypeOf(e.details).toEqualTypeOf<Record<string, unknown> | undefined>()
    expect(e.details).toEqual({ a: 1 })
  })
})
