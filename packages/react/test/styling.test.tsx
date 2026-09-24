import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { describe, expect, it } from 'vitest'
import {
  ApprovalQueue,
  ClearedByProvider,
  DecisionBar,
  ReviewPanel,
  RulesSummary,
  type ClearedByProviderProps,
  type UiBadgeProps,
  type UiButtonProps,
  type UiDialogProps,
} from '../src'
import { baseItem, fakeProxy, perms, rules } from './fixtures'

const api = () =>
  fakeProxy({
    'GET /items': () => ({ items: [baseItem({ id: 'a' })], next_cursor: null }),
    'GET /items/item_1': () => baseItem({
      evidence: {
        claims: [{ type: 'note', label: 'Agent note', value: 'hello', provenance: 'agent_claim', verified_by: null, verified_at: null }],
        verified: [],
      },
    }),
    'GET /items/item_1/permissions': () => perms(['clear', 'reject']),
    'GET /items/item_1/events': () => ({ events: [] }),
    'GET /rules': () => rules(),
    'PUT /rules': () => ({ status: 202, body: { status: 'needs_owner_approval', proposal_id: 'p1', proposal_version: 3, strictness: 'looser', summary_diff: [{ key: 'k', action_label: 'x', before: 'Before line', after: 'After line' }], summary: [] } }),
  })

const ui = (props: Omit<ClearedByProviderProps, 'children'>, children: ReactNode) => {
  const a = api()
  return { ...render(<ClearedByProvider fetch={a.fetch} pollInterval={0} fetchTheme={false} {...props}>{children}</ClearedByProvider>), api: a }
}

const cbClasses = (root: Element) =>
  Array.from(root.querySelectorAll('[class]')).flatMap((el) => Array.from(el.classList)).filter((c) => c.startsWith('cb-'))

describe('styling levels', () => {
  it('default: every part gets its cb-* class', async () => {
    const { container } = ui({}, <ReviewPanel id="item_1" />)
    await screen.findByRole('button', { name: 'Approve' })
    const classes = cbClasses(container)
    for (const c of ['cb-root', 'cb-heading', 'cb-badge', 'cb-button', 'cb-button--primary', 'cb-evidence-group', 'cb-kv']) {
      expect(classes).toContain(c)
    }
  })

  it('unstyled (provider): no default cb-* class anywhere', async () => {
    const { container } = ui({ unstyled: true }, <><ApprovalQueue /><ReviewPanel id="item_1" /><RulesSummary /></>)
    await screen.findByRole('button', { name: 'Approve' })
    await screen.findByText('Refunds over £25 need your OK')
    expect(cbClasses(container)).toEqual([])
  })

  it('unstyled (per component) + classNames: only your classes', async () => {
    const { container } = ui({}, (
      <DecisionBar
        id="item_1"
        unstyled
        className="my-bar"
        classNames={{ button: 'btn', primaryButton: 'btn-primary', dangerButton: 'btn-danger', buttonRow: 'row' }}
      />
    ))
    const approve = await screen.findByRole('button', { name: 'Approve' })
    expect(approve.className).toBe('btn btn-primary')
    expect(screen.getByRole('button', { name: 'Decline' }).className).toBe('btn btn-danger')
    expect(screen.getByRole('group').className).toBe('row')
    expect(container.querySelector('.my-bar')).not.toBeNull()
    expect(cbClasses(container)).toEqual([])
  })

  it('classNames from the provider and the component are merged onto the defaults', async () => {
    ui({ classNames: { card: 'shadow-sm', badge: 'rounded-full' } }, <ApprovalQueue classNames={{ card: 'px-4', heading: 'text-lg' }} />)
    const card = await screen.findByRole('button', { name: /Refund/ })
    expect(card.className.split(' ')).toEqual(expect.arrayContaining(['cb-card', 'shadow-sm', 'px-4']))
    expect(screen.getByRole('heading').className).toBe('cb-heading text-lg')
    expect(card.querySelector('.rounded-full')).not.toBeNull()
  })

  it('injected components are used for buttons, badges, textareas and dialogs', async () => {
    const Button = ({ variant, className: _c, ...rest }: UiButtonProps) => <button data-ds="button" data-variant={variant} {...rest} />
    const Badge = ({ tone, children }: UiBadgeProps) => <em data-ds="badge" data-tone={tone}>{children}</em>
    const Textarea = (p: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea data-ds="textarea" {...p} />
    const Dialog = ({ open, title, titleId, children }: UiDialogProps) =>
      open ? <div data-ds="dialog" role="dialog" aria-labelledby={titleId}><b id={titleId}>{title}</b>{children}</div> : null
    ui({ components: { Button, Badge, Textarea, Dialog } }, <><ReviewPanel id="item_1" showHistory={false} /><RulesSummary /></>)

    const approve = await screen.findByRole('button', { name: 'Approve' })
    expect(approve.getAttribute('data-ds')).toBe('button')
    expect(approve.getAttribute('data-variant')).toBe('primary')
    expect(screen.getByRole('button', { name: 'Decline' }).getAttribute('data-variant')).toBe('danger')
    expect(document.querySelector('[data-ds="badge"][data-tone="waiting"]')?.textContent).toBe('Waiting')

    await userEvent.click(screen.getByRole('button', { name: 'Decline' }))
    expect(screen.getByLabelText('Why are you declining?').getAttribute('data-ds')).toBe('textarea')

    // The owner's "less strict" confirmation renders in the injected Dialog.
    await userEvent.click(await screen.findByRole('button', { name: 'Adjust' }))
    await userEvent.click(screen.getByRole('button', { name: 'Save' })) // unchanged → nothing to confirm
    await userEvent.click(await screen.findByRole('button', { name: 'Adjust' }))
    const field = screen.getByLabelText(/Refunds up to this amount/)
    await userEvent.clear(field)
    await userEvent.type(field, '80')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.getAttribute('data-ds')).toBe('dialog')
    expect(dialog.textContent).toContain('After line')
  })

  it('labels override any wording', async () => {
    ui({ labels: { queueTitle: 'Needs a look', status: { pending: 'To do' } } }, <ApprovalQueue />)
    expect(await screen.findByRole('heading', { name: 'Needs a look' })).toBeTruthy()
    await waitFor(() => expect(screen.getByText('To do')).toBeTruthy())
  })

  it('renders no inline styles on component parts', async () => {
    const { container } = ui({}, <><ApprovalQueue /><ReviewPanel id="item_1" /></>)
    await screen.findByRole('button', { name: 'Approve' })
    // The only inline style is the theme scope wrapper (display: contents).
    const styled = Array.from(container.querySelectorAll('[style]'))
    expect(styled.map((e) => e.getAttribute('data-cb-theme') !== null)).toEqual([true])
  })
})
