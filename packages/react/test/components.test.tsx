import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import {
  ApprovalQueue,
  CancelButton,
  ChangesTable,
  ClearedByProvider,
  DecisionBar,
  EvidenceList,
  History,
  ReviewPanel,
  RulesSummary,
} from '../src'
import { baseItem, fakeProxy, perms, rules } from './fixtures'

const ui = (fetch: typeof globalThis.fetch, children: ReactNode, labels?: Parameters<typeof ClearedByProvider>[0]['labels']) =>
  render(<ClearedByProvider fetch={fetch} pollInterval={0} locale="en-GB" labels={labels} fetchTheme={false}>{children}</ClearedByProvider>)

describe('<ApprovalQueue>', () => {
  it('renders waiting items in plain English and selects one with the keyboard', async () => {
    const api = fakeProxy({
      'GET /items': () => ({
        items: [
          baseItem({ id: 'a' }),
          baseItem({ id: 'b', action: 'shopify.price.update', params: { store: 'x.myshopify.com', count: 3000, currency: 'GBP', changes: [] } }),
        ],
        next_cursor: null,
      }),
    })
    const onSelect = vi.fn()
    ui(api.fetch, <ApprovalQueue onSelect={onSelect} />)
    expect(await screen.findByText('Refund £18.50 on order #6001')).toBeTruthy()
    expect(screen.getByText('Change prices on 3,000 products')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Waiting for your OK' })).toBeTruthy()
    const cards = screen.getAllByRole('button')
    cards[0]!.focus()
    fireEvent.keyDown(cards[0]!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(cards[1])
    await userEvent.keyboard('{Enter}')
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'b' }))
    // Nothing merchant-facing mentions the vendor or "policy".
    expect(document.body.textContent).not.toMatch(/clearedby|policy/i)
  })

  it('shows an empty state and an error with retry', async () => {
    let fail = true
    const api = fakeProxy({
      'GET /items': () => (fail ? { status: 500, body: { error: { code: 'x', message: 'x' } } } : { items: [], next_cursor: null }),
    })
    ui(api.fetch, <ApprovalQueue />)
    const alert = await screen.findByRole('alert')
    fail = false
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('Nothing is waiting for you.')).toBeTruthy()
  })
})

describe('<DecisionBar>', () => {
  it('only shows the buttons this person is allowed to press', async () => {
    const api = fakeProxy({
      'GET /items/item_1/permissions': () => perms(['reject', 'send_back', 'escalate'], [
        { decision: 'clear', status: 403, code: 'no_authority', message: 'no' },
      ]),
    })
    ui(api.fetch, <DecisionBar id="item_1" />)
    expect(await screen.findByRole('button', { name: 'Decline' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Send back with a note' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Ask someone else' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(screen.getByText('This is over your approval limit.')).toBeTruthy()
  })

  it('declining requires a reason before anything is sent', async () => {
    const api = fakeProxy({
      'GET /items/item_1/permissions': () => perms(['clear', 'reject', 'send_back', 'escalate']),
      'POST /items/item_1/decide': () => ({ status: 'rejected' }),
    })
    const onDecided = vi.fn()
    ui(api.fetch, <DecisionBar id="item_1" onDecided={onDecided} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Decline' }))
    const box = screen.getByLabelText('Why are you declining?')
    expect(box.getAttribute('aria-required')).toBe('true')
    await userEvent.click(screen.getByRole('button', { name: 'Decline' }))
    expect(screen.getByRole('alert').textContent).toMatch(/at least 4 characters/)
    expect(box.getAttribute('aria-invalid')).toBe('true')
    expect(api.calls.some((c) => c.method === 'POST')).toBe(false)

    await userEvent.type(box, 'Customer already got a replacement')
    await userEvent.click(screen.getByRole('button', { name: 'Decline' }))
    await waitFor(() => expect(onDecided).toHaveBeenCalledWith({ status: 'rejected' }, 'reject'))
    const post = api.calls.find((c) => c.method === 'POST')!
    expect(post.body).toEqual({ decision: 'reject', reason: 'Customer already got a replacement' })
    expect(await screen.findByRole('status')).toBeTruthy()
    expect(screen.getByText('Declined.')).toBeTruthy()
  })

  it('approves in one click; Escape closes a note form', async () => {
    const api = fakeProxy({
      'GET /items/item_1/permissions': () => perms(['clear', 'send_back']),
      'POST /items/item_1/decide': () => ({ status: 'pending', approvals: 1, required: 2 }),
    })
    ui(api.fetch, <DecisionBar id="item_1" />)
    await userEvent.click(await screen.findByRole('button', { name: 'Send back with a note' }))
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('textbox')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }))
    expect(await screen.findByText('Thanks. One more person needs to approve this.')).toBeTruthy()
    expect(api.calls.find((c) => c.method === 'POST')!.body).toEqual({ decision: 'clear' })
  })

  it('shows why when there is nothing to do', async () => {
    const api = fakeProxy({
      'GET /items/item_1/permissions': () => perms([], [{ decision: 'clear', status: 409, code: 'not_pending', message: 'x' }]),
    })
    ui(api.fetch, <DecisionBar id="item_1" />)
    expect(await screen.findByText('This has already been decided.')).toBeTruthy()
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })

  it('labels can be overridden', async () => {
    const api = fakeProxy({ 'GET /items/item_1/permissions': () => perms(['clear']) })
    ui(api.fetch, <DecisionBar id="item_1" />, { decisions: { clear: 'Yes, go ahead' } })
    expect(await screen.findByRole('button', { name: 'Yes, go ahead' })).toBeTruthy()
  })
})

describe('<EvidenceList>', () => {
  it('groups evidence by who vouches for it — an agent claim never shows as verified', () => {
    const api = fakeProxy({})
    ui(api.fetch, (
      <EvidenceList
        currency="GBP"
        evidence={{
          claims: [
            { type: 'order_lookup', label: 'Order (as the agent read it)', value: { total: 40, refunded: 0, verified: true }, provenance: 'agent_claim', verified_by: null, verified_at: null },
          ],
          verified: [
            { id: 'e1', type: 'order_lookup', label: 'Shopify order', value: { total: 400, refunded: 400 }, provenance: 'partner_verified', verified_by: 'partner:p1', verifier_name: 'Intersession', verified_at: '2026-09-23T10:01:00.000Z' },
            { type: 'currency', label: 'Currency check', value: { amount: 120, currency: 'GBP', policy_currency: 'GBP', policy_currency_source: 'policy', matches_policy_currency: true }, provenance: 'clearedby_computed', verified_by: 'clearedby', verified_at: '2026-09-23T10:00:00.000Z' },
            { type: 'aggregate', label: 'sum(amount, 86400s) by order_id (computed by ClearedBy)', value: { fn: 'sum', field: 'amount', window_seconds: 86400, by: 'params.order_id', prior: 180, including_this_request: 300 }, provenance: 'clearedby_computed', verified_by: 'clearedby', verified_at: '2026-09-23T10:00:00.000Z' },
            { id: 'e2', type: 'note', label: 'Tampered', value: 'x', provenance: 'partner_verified', verified_by: 'partner:p1', verifier_name: 'Intersession', verified_at: null, integrity: 'mismatch' },
          ],
        }}
      />
    ))
    const verified = screen.getByRole('region', { name: 'Verified by Intersession' })
    const computed = screen.getByRole('region', { name: 'Checked automatically' })
    const agent = screen.getByRole('region', { name: 'Agent says' })
    expect(within(verified).getByText('Shopify order')).toBeTruthy()
    expect(within(verified).getByRole('alert').textContent).toMatch(/changed after it was added/)
    // Automatic checks are re-phrased in plain words (their stored labels are technical).
    expect(within(computed).getByText('Amount')).toBeTruthy()
    expect(within(computed).getByText('£120.00')).toBeTruthy()
    expect(within(computed).getByText('Total in the last 24 hours on this order')).toBeTruthy()
    expect(within(computed).getByText('£300.00 including this one (£180.00 before)')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/clearedby|policy/i)
    expect(within(agent).getByText('Order (as the agent read it)')).toBeTruthy()
    expect(within(verified).queryByText('Order (as the agent read it)')).toBeNull()
    // Verified first, then computed, then the agent's word.
    const order = screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'))
    expect(order).toEqual(['Verified by Intersession', 'Checked automatically', 'Agent says'])
  })
})

describe('<ReviewPanel>', () => {
  it('shows the action in plain English, the why, the details and the decision bar', async () => {
    const api = fakeProxy({
      'GET /items/item_1': () => baseItem(),
      'GET /items/item_1/permissions': () => perms(['clear', 'reject']),
      'GET /items/item_1/events': () => ({ events: [{ work_item_id: 'item_1', id: 'e1', kind: 'created', at: new Date().toISOString(), actor: null, data: {} }] }),
    })
    ui(api.fetch, <ReviewPanel id="item_1" />)
    expect(await screen.findByRole('heading', { name: 'Refund £18.50 on order #6001' })).toBeTruthy()
    expect(screen.getByText('Refund an order')).toBeTruthy()
    expect(screen.getByText('Customer sent photos of the damage')).toBeTruthy()
    expect(await screen.findByRole('button', { name: 'Approve' })).toBeTruthy()
    expect(await screen.findByText('Asked for approval')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/clearedby|policy/i)
  })

  it('pages a 3,000-item batch with a summary on top', async () => {
    const changes = Array.from({ length: 3000 }, (_, i) => ({
      variant_id: `gid://shopify/ProductVariant/${i}`,
      label: `Shirt ${i + 1}`,
      before: { price: '40.00' },
      after: { price: i % 2 === 0 ? '30.00' : '44.00' },
    }))
    const api = fakeProxy({})
    ui(api.fetch, <ChangesTable item={{ action: 'shopify.price.update', params: { currency: 'GBP', count: 3000, max_drop_pct: 25, changes } }} />)
    expect(screen.getByText('3,000 changes')).toBeTruthy()
    expect(screen.getByText(/1,500 cheaper · 1,500 more expensive · biggest drop 25%/)).toBeTruthy()
    expect(screen.getAllByRole('row')).toHaveLength(51) // header + 50
    expect(screen.getByText('Showing 1–50 of 3,000')).toBeTruthy()
    expect(screen.getByRole('rowheader', { name: 'Shirt 1' })).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByText('Showing 51–100 of 3,000')).toBeTruthy()
    expect(screen.getByRole('rowheader', { name: 'Shirt 51' })).toBeTruthy()
    expect(screen.queryByRole('rowheader', { name: 'Shirt 1' })).toBeNull()
  })
})

describe('<CancelButton>', () => {
  it('appears only for an approved change that hasn’t run, and needs a reason', async () => {
    const api = fakeProxy({
      'GET /items/item_1': () => baseItem({ status: 'cleared' }),
      'POST /items/item_1/revoke': () => ({ id: 'item_1', status: 'revoked', revoked_at: '', dispatch: 'cancelled', stopped_partial: false }),
    })
    ui(api.fetch, <CancelButton id="item_1" />)
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel before it runs' }))
    await userEvent.click(screen.getByRole('button', { name: 'Yes, cancel it' }))
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(api.calls.some((c) => c.method === 'POST')).toBe(false)
    await userEvent.type(screen.getByLabelText('Why are you cancelling?'), 'customer cancelled')
    await userEvent.click(screen.getByRole('button', { name: 'Yes, cancel it' }))
    expect(await screen.findByText('Cancelled. It won’t run.')).toBeTruthy()
  })

  it('renders nothing once the change has run', async () => {
    const api = fakeProxy({
      'GET /items/item_1': () => baseItem({ status: 'cleared', completion: { status: 'done', ref: null, completed_at: '', diverged: false } }),
    })
    const { container } = ui(api.fetch, <CancelButton id="item_1" />)
    await waitFor(() => expect(api.calls.length).toBe(1))
    expect(container.textContent).toBe('')
  })
})

describe('<History>', () => {
  it('tells the story in plain words, including revisions, execution and undo', async () => {
    const at = new Date().toISOString()
    const ev = (id: string, item: string, kind: string, data: Record<string, unknown> = {}, actor: unknown = null) =>
      ({ work_item_id: item, id, kind, at, actor, data })
    const api = fakeProxy({
      'GET /items/item_2/events': () => ({
        events: [
          ev('1', 'item_1', 'created'),
          ev('2', 'item_1', 'evaluated'),
          ev('3', 'item_1', 'decided', { status: 'sent_back' }, { type: 'user', ref: 'user:u1', name: 'Sam' }),
          ev('4', 'item_2', 'created', { attempt: 2 }),
          ev('5', 'item_2', 'decided', { status: 'cleared' }, { type: 'user', ref: 'user:u1', name: 'Sam' }),
          ev('6', 'item_2', 'dispatch_attempt'),
          ev('7', 'item_2', 'completed', { status: 'done' }),
        ],
      }),
      'GET /items/item_9/events': () => ({ events: [ev('1', 'item_9', 'created', { reverts: 'item_2' })] }),
    })
    ui(api.fetch, <><History id="item_2" /><History id="item_9" /></>)
    expect(await screen.findByText('Sent back to be changed')).toBeTruthy()
    expect(screen.getByText('Revised and asked again')).toBeTruthy()
    expect(screen.getByText('Approved')).toBeTruthy()
    expect(screen.getByText('Done')).toBeTruthy()
    expect(await screen.findByText('Asked to undo an earlier change')).toBeTruthy()
    // Technical steps are hidden.
    expect(screen.queryByText(/evaluated|dispatch/i)).toBeNull()
  })
})

describe('<RulesSummary>', () => {
  it('shows the rules; a looser change is confirmed by an owner and accepted', async () => {
    let accepted = false
    const api = fakeProxy({
      'GET /rules': () => rules(),
      'PUT /rules': () => ({
        status: 202,
        body: {
          status: 'needs_owner_approval',
          proposal_id: 'p9',
          proposal_version: 3,
          strictness: 'looser',
          summary_diff: [{ key: 'refund_auto_max', action_label: 'Refunds', before: 'Refunds over £25 need your OK', after: 'Refunds over £50 need your OK' }],
          summary: [],
        },
      }),
      'POST /rules/proposals/p9/accept': () => {
        accepted = true
        return { status: 'active' }
      },
    })
    ui(api.fetch, <RulesSummary />)
    expect(await screen.findByText('Refunds over £25 need your OK')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Adjust' }))
    const field = screen.getByLabelText(/Refunds up to this amount go through on their own/)
    await userEvent.clear(field)
    await userEvent.type(field, '50')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('This makes your rules less strict')).toBeTruthy()
    expect(screen.getByText('Refunds over £50 need your OK')).toBeTruthy()
    expect(api.calls.find((c) => c.method === 'PUT')!.body).toEqual({ settings: { refund_auto_max: 50 } })
    await userEvent.click(screen.getByRole('button', { name: 'Yes, change it' }))
    expect(await screen.findByText('Done. Your new rules are on.')).toBeTruthy()
    expect(accepted).toBe(true)
    expect(document.body.textContent).not.toMatch(/clearedby|policy/i)
  })

  it('a non-owner is told the store owner needs to approve; spot checks have a "How often"', async () => {
    const api = fakeProxy({
      'GET /rules': () => rules({ viewer: { role: 'reviewer', can_edit: true, can_accept: false } }),
      'PUT /rules': () => ({ status: 202, body: { status: 'needs_owner_approval', proposal_id: 'p1', proposal_version: 3, strictness: 'stricter', summary_diff: [], summary: [] } }),
    })
    ui(api.fetch, <RulesSummary />)
    await userEvent.click(await screen.findByRole('button', { name: 'Adjust' }))
    const toggle = screen.getByRole('switch', { name: /Occasional spot-checks/ })
    await userEvent.click(toggle)
    await userEvent.selectOptions(screen.getByLabelText('How often'), 'About 1 in 10')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(api.calls.find((c) => c.method === 'PUT')!.body).toEqual({ settings: { spot_checks: true, spot_check_pct: 10 } })
    expect(await screen.findByText('Your store owner needs to approve this change.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Yes, change it' })).toBeNull()
  })

  it('a stricter change is saved at once; "Looks good" needs no call', async () => {
    const api = fakeProxy({
      'GET /rules': () => rules(),
      'PUT /rules': () => ({ status: 'active', active_version: 3, strictness: 'stricter', unchanged: false, summary: [] }),
    })
    const onLooksGood = vi.fn()
    ui(api.fetch, <RulesSummary onLooksGood={onLooksGood} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Looks good' }))
    expect(onLooksGood).toHaveBeenCalled()
    expect(api.calls.filter((c) => c.method !== 'GET')).toHaveLength(0)
    await userEvent.click(screen.getByRole('button', { name: 'Adjust' }))
    const field = screen.getByLabelText(/Refunds up to this amount/)
    await userEvent.clear(field)
    await userEvent.type(field, '10')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText('Saved. Your new rules are on.')).toBeTruthy()
  })

  it('an owner sees a pending proposal and can accept it', async () => {
    const api = fakeProxy({
      'GET /rules': () => rules({
        pending_proposal: {
          proposal_id: 'p5', version: 4, settings: rules().settings!, summary: [], created_at: '',
          summary_diff: [{ key: 'spot_checks', action_label: 'Spot-checks', before: 'Now and then (about 1 in 20)…', after: '' }],
        },
      }),
      'POST /rules/proposals/p5/accept': () => ({ status: 'active' }),
    })
    ui(api.fetch, <RulesSummary />)
    expect(await screen.findByText('A change to your rules is waiting for your OK')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Yes, change it' }))
    expect(await screen.findByText('Done. Your new rules are on.')).toBeTruthy()
  })
})
