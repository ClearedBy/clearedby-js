// Shapes the proxy (@clearedby/sdk/partner-proxy) returns. They mirror the
// ClearedBy read API (docs/partner-api.md "Reading clearances"), minus anything
// credential-like, which the proxy strips.

export type ItemStatus = 'pending' | 'escalated' | 'cleared' | 'rejected' | 'expired' | 'sent_back' | 'revoked' | 'withdrawn'
export type Decision = 'clear' | 'reject' | 'send_back' | 'escalate'
export type EvidenceProvenance = 'agent_claim' | 'partner_verified' | 'clearedby_computed'

export interface Person {
  user_id: string
  external_subject: string | null
  name: string
}

export interface EvidenceItem {
  id?: string
  type: string
  value: unknown
  label?: string
  source_ref?: string
  provenance: EvidenceProvenance
  verified_by: string | null
  verifier_name?: string
  verified_at: string | null
  sha256?: string
  integrity?: 'ok' | 'mismatch' | 'uncommitted'
}

export interface Approval {
  id: string
  status: ItemStatus
  action: string
  summary: string | null
  params?: Record<string, unknown>
  proof?: {
    reason?: string
    confidence?: number
    recommended_outcome?: string
    risk_flags?: string[]
    evidence?: unknown[]
  } | null
  evidence?: { claims: EvidenceItem[]; verified: EvidenceItem[] }
  context?: Record<string, unknown>
  batch_id: string | null
  attempt: number
  parent_item_id: string | null
  children?: { id: string; status: ItemStatus; attempt: number; created_at: string }[]
  routed_to: Person[]
  escalation: { to: Person | null; at: string | null; reason: string | null } | null
  dual_review: { required: number; approvals: Person[] } | null
  expires_at: string | null
  verdict_source: string | null
  decided_by: Person | null
  decided_at: string | null
  reason: string | null
  completion: { status: string | null; ref: string | null; completed_at: string; diverged: boolean } | null
  revoked_at?: string | null
  created_at: string
  updated_at: string
}

export interface ApprovalPage {
  items: Approval[]
  next_cursor: string | null
}

export interface HistoryEvent {
  work_item_id: string
  id: string
  kind: string
  at: string
  actor: {
    type: 'user' | 'policy' | 'system' | 'agent' | 'partner'
    ref: string | null
    user_id?: string
    external_subject?: string | null
    name?: string
  } | null
  target?: Person | null
  data: Record<string, unknown> | null
}

export interface Permissions {
  id: string
  status: ItemStatus
  reviewer: Person
  can: Decision[]
  cannot: { decision: Decision; status: number; code: string; message: string }[]
  requires_passkey: boolean
  reason_required: Decision[]
  dual_review: { required: number; approvals: string[] } | null
  send_back_forces?: 'reject' | 'escalate'
}

export interface DecideResult {
  status: 'cleared' | 'rejected' | 'pending' | 'escalated' | 'sent_back'
  approvals?: number
  required?: number
}

export interface RevokeResult {
  id: string
  status: 'revoked'
  revoked_at: string
  dispatch: 'none' | 'cancelled' | 'in_flight' | 'delivered' | 'gave_up'
  stopped_partial: boolean
}

export interface RulesSettings {
  tags_auto_max_products: number
  inventory_auto_max_items: number
  price_changes: 'always_review' | 'review_drops_over_pct'
  price_drop_review_pct: number
  discounts: 'always_review'
  refund_auto_max: number
  refund_dual_above: number | null
  refund_daily_auto_cap: number | null
  refund_per_order_cap: number | null
  order_cancel: 'always_review'
  timeout_hours: number
  spot_checks?: boolean
  spot_check_pct?: number
}

export interface RulesLine {
  key: string
  action_label: string
  sentence: string
}

export interface RulesDiffLine {
  key: string
  action_label: string
  before: string
  after: string
}

export interface RulesProposal {
  proposal_id: string
  version: number
  settings: RulesSettings
  summary: RulesLine[]
  summary_diff: RulesDiffLine[]
  created_at: string
}

export interface Rules {
  settings: RulesSettings | null
  summary: RulesLine[]
  active_version: number | null
  currency: string
  refund_approvers?: number
  pending_proposal?: RulesProposal
  /** Added by the proxy: who is looking. */
  viewer?: { role: string | null; can_edit: boolean; can_accept: boolean }
}

export type ProposeResult =
  | { status: 'active'; active_version: number; strictness: string; unchanged: boolean; summary: RulesLine[] }
  | {
      status: 'needs_owner_approval'
      proposal_id: string
      proposal_version: number
      strictness: string
      summary_diff: RulesDiffLine[]
      summary: RulesLine[]
    }
