// Every word the components show. Written for merchants, not developers: no
// "policy", no product names, no jargon. Override any of it with the `labels`
// prop on <ClearedByProvider> (or on a single component).

import type { Decision, ItemStatus } from './types'

export interface Labels {
  // Queue
  queueTitle: string
  queueEmpty: string
  loading: string
  loadError: string
  retry: string
  loadMore: string
  needsTwo: (have: number, need: number) => string
  sentToYou: string
  expiresIn: (text: string) => string

  // Status badges
  status: Record<ItemStatus, string>

  // Review panel
  whyTitle: string
  detailsTitle: string
  changesTitle: string
  changesSummary: (count: number) => string
  showing: (from: number, to: number, total: number) => string
  previousPage: string
  nextPage: string
  columnItem: string
  columnBefore: string
  columnAfter: string
  confidence: (pct: number) => string
  evidenceTitle: string
  evidenceAgent: string
  evidenceVerifiedBy: (name: string) => string
  evidenceComputed: string
  evidenceChanged: string
  evidenceAgentHint: string
  revisionOf: (attempt: number) => string
  decidedBy: (status: string, who: string) => string
  reasonGiven: string

  // Decisions
  decisionGroup: string
  actionError: string
  saveError: string
  decisions: Record<Decision, string>
  reasonPrompt: Record<'reject' | 'send_back' | 'escalate', string>
  reasonPlaceholder: Record<'reject' | 'send_back' | 'escalate', string>
  reasonTooShort: string
  confirm: Record<Decision, string>
  cancel: string
  working: string
  decided: Record<'cleared' | 'rejected' | 'pending' | 'escalated' | 'sent_back', string>
  nothingToDo: string
  cannot: Record<string, string>

  // Cancel before it runs
  cancelBeforeRuns: string
  cancelPrompt: string
  cancelPlaceholder: string
  cancelConfirm: string
  cancelled: string
  cancelledButMayHaveStarted: string

  // History
  historyTitle: string
  historyEmpty: string
  event: (kind: string, data: Record<string, unknown>) => string | null
  someone: string
  automatic: string

  // Rules
  rulesTitle: string
  rulesIntro: string
  looksGood: string
  adjust: string
  save: string
  saving: string
  rulesSaved: string
  rulesUnchanged: string
  rulesNeedOwner: string
  rulesLooserTitle: string
  rulesYesChange: string
  rulesPendingTitle: string
  rulesAccepted: string
  never: string
  settings: {
    refund_auto_max: string
    refund_dual_above: string
    refund_daily_auto_cap: string
    refund_per_order_cap: string
    tags_auto_max_products: string
    inventory_auto_max_items: string
    price_changes: string
    price_changes_always: string
    price_changes_drops: string
    price_drop_review_pct: string
    timeout_hours: string
    spot_checks: string
    spot_checks_help: string
    spot_check_how_often: string
  }
  oneIn: (n: number) => string
}

const EVENT_LABELS: Record<string, string> = {
  routed: 'Sent for approval',
  reminder: 'Reminder sent',
  escalated: 'Handed to someone else',
  expired: 'Nobody answered in time, so it was cancelled',
  evidence_attached: 'Facts added',
  dispatch_delivered: 'Sent off to be carried out',
  revoked: 'Cancelled before it ran',
  withdrawn: 'Request withdrawn',
}

export const DEFAULT_LABELS: Labels = {
  queueTitle: 'Waiting for your OK',
  queueEmpty: 'Nothing is waiting for you.',
  loading: 'Loading…',
  loadError: 'We couldn’t load this.',
  retry: 'Try again',
  loadMore: 'Show more',
  needsTwo: (have, need) => `Needs ${need} people to approve (${have} so far)`,
  sentToYou: 'Sent to you',
  expiresIn: (text) => `Cancelled automatically ${text} if nobody answers`,

  status: {
    pending: 'Waiting',
    escalated: 'Waiting',
    cleared: 'Approved',
    rejected: 'Declined',
    expired: 'Lapsed',
    sent_back: 'Sent back',
    revoked: 'Cancelled',
    withdrawn: 'Withdrawn',
  },

  whyTitle: 'Why',
  detailsTitle: 'Details',
  changesTitle: 'What will change',
  changesSummary: (n) => `${n.toLocaleString()} ${n === 1 ? 'change' : 'changes'}`,
  showing: (from, to, total) => `Showing ${from.toLocaleString()}–${to.toLocaleString()} of ${total.toLocaleString()}`,
  previousPage: 'Previous',
  nextPage: 'Next',
  columnItem: 'Item',
  columnBefore: 'Now',
  columnAfter: 'After',
  confidence: (pct) => `Assistant’s confidence: ${pct}%`,
  evidenceTitle: 'The facts',
  evidenceAgent: 'Agent says',
  evidenceVerifiedBy: (name) => `Verified by ${name}`,
  evidenceComputed: 'Checked automatically',
  evidenceChanged: 'Warning: this was changed after it was added',
  evidenceAgentHint: 'Not checked yet: this is what the assistant says.',
  revisionOf: (attempt) => `Revised request (attempt ${attempt})`,
  decidedBy: (status, who) => `${status} by ${who}`,
  reasonGiven: 'Note',

  decisionGroup: 'Your decision',
  actionError: 'That didn’t work. Please try again.',
  saveError: 'We couldn’t save that. Please check the numbers and try again.',
  decisions: {
    clear: 'Approve',
    reject: 'Decline',
    send_back: 'Send back with a note',
    escalate: 'Ask someone else',
  },
  reasonPrompt: {
    reject: 'Why are you declining?',
    send_back: 'What should be changed?',
    escalate: 'Add a note (optional)',
  },
  reasonPlaceholder: {
    reject: 'For example: the customer already got a replacement',
    send_back: 'For example: refund the shipping only',
    escalate: 'For example: this is over my limit',
  },
  reasonTooShort: 'Please write a few words (at least 4 characters).',
  confirm: {
    clear: 'Approve',
    reject: 'Decline',
    send_back: 'Send back',
    escalate: 'Ask someone else',
  },
  cancel: 'Cancel',
  working: 'Working…',
  decided: {
    cleared: 'Approved.',
    rejected: 'Declined.',
    pending: 'Thanks. One more person needs to approve this.',
    escalated: 'Handed to someone else.',
    sent_back: 'Sent back with your note.',
  },
  nothingToDo: 'There’s nothing for you to do here.',
  cannot: {
    not_pending: 'This has already been decided.',
    no_authority: 'This is over your approval limit.',
    already_approved: 'You’ve approved this. It needs one more person.',
    self_approval: 'You asked for this, so someone else needs to approve it.',
    requester_cannot_approve: 'You asked for this, so someone else needs to approve it.',
    forbidden: 'You can’t approve things for this business.',
    passkey_required: 'This needs to be approved somewhere else.',
    passkey_required_not_supported_for_partner: 'This needs to be approved somewhere else.',
  },

  cancelBeforeRuns: 'Cancel before it runs',
  cancelPrompt: 'Why are you cancelling?',
  cancelPlaceholder: 'For example: the customer cancelled the order',
  cancelConfirm: 'Yes, cancel it',
  cancelled: 'Cancelled. It won’t run.',
  cancelledButMayHaveStarted: 'Cancelled. It may already have started, so please check.',

  historyTitle: 'History',
  historyEmpty: 'No history yet.',
  event: (kind, data) => {
    if (kind === 'created') {
      if (typeof data.reverts === 'string') return 'Asked to undo an earlier change'
      if (typeof data.attempt === 'number' && data.attempt > 1) return 'Revised and asked again'
      return 'Asked for approval'
    }
    if (kind === 'decided') {
      switch (data.status) {
        case 'cleared': return 'Approved'
        case 'rejected': return 'Declined'
        case 'sent_back': return 'Sent back to be changed'
        case 'escalated': return 'Handed to someone else'
        case 'pending': return 'Approved (one more person needed)'
        default: return 'Decided'
      }
    }
    if (kind === 'completed') {
      switch (data.status) {
        case 'done': return 'Done'
        case 'failed': return 'Tried, but it didn’t work'
        case 'partial': return 'Partly done'
        default: return 'Carried out'
      }
    }
    return EVENT_LABELS[kind] ?? null
  },
  someone: 'Someone',
  automatic: 'Automatically',

  rulesTitle: 'Your approval rules',
  rulesIntro: 'Your assistant can make some changes on its own. Anything bigger waits for you.',
  looksGood: 'Looks good',
  adjust: 'Adjust',
  save: 'Save',
  saving: 'Saving…',
  rulesSaved: 'Saved. Your new rules are on.',
  rulesUnchanged: 'Nothing changed.',
  rulesNeedOwner: 'Your store owner needs to approve this change.',
  rulesLooserTitle: 'This makes your rules less strict',
  rulesYesChange: 'Yes, change it',
  rulesPendingTitle: 'A change to your rules is waiting for your OK',
  rulesAccepted: 'Done. Your new rules are on.',
  never: 'Never',
  settings: {
    refund_auto_max: 'Refunds up to this amount go through on their own',
    refund_dual_above: 'Refunds over this amount need two people',
    refund_daily_auto_cap: 'After this much is refunded in a day, ask me',
    refund_per_order_cap: 'Refunds on one order adding up to more than this need my OK',
    tags_auto_max_products: 'Tag changes to up to this many products go through on their own',
    inventory_auto_max_items: 'Stock updates for up to this many items go through on their own',
    price_changes: 'Price changes',
    price_changes_always: 'Always ask me',
    price_changes_drops: 'Only ask me about big price drops',
    price_drop_review_pct: 'Ask me about drops bigger than (%)',
    timeout_hours: 'Cancel requests nobody answers after (hours)',
    spot_checks: 'Occasional spot-checks',
    spot_checks_help: 'Now and then, we’ll ask you to double-check something that would normally go through automatically.',
    spot_check_how_often: 'How often',
  },
  oneIn: (n) => `About 1 in ${n}`,
}

export type LabelOverrides = Partial<Omit<Labels, 'status' | 'decisions' | 'reasonPrompt' | 'reasonPlaceholder' | 'confirm' | 'decided' | 'cannot' | 'settings'>> & {
  status?: Partial<Labels['status']>
  decisions?: Partial<Labels['decisions']>
  reasonPrompt?: Partial<Labels['reasonPrompt']>
  reasonPlaceholder?: Partial<Labels['reasonPlaceholder']>
  confirm?: Partial<Labels['confirm']>
  decided?: Partial<Labels['decided']>
  cannot?: Partial<Labels['cannot']>
  settings?: Partial<Labels['settings']>
}

const NESTED = ['status', 'decisions', 'reasonPrompt', 'reasonPlaceholder', 'confirm', 'decided', 'cannot', 'settings'] as const

/** Merge overrides onto a base set, one level deep for the grouped labels. */
export function mergeLabels(base: Labels, overrides?: LabelOverrides): Labels {
  if (overrides === undefined) return base
  const out = { ...base, ...overrides } as Labels
  for (const k of NESTED) {
    const o = overrides[k]
    if (o !== undefined) (out as unknown as Record<string, unknown>)[k] = { ...base[k], ...o }
  }
  return out
}
