// @clearedby/sdk (CLE-15) — a tiny, dependency-free client for the ClearedBy
// gate. Call gate() before a consequential agent action; the policy either
// clears it instantly, rejects it, or holds it for a human. wait() blocks
// until a held item resolves; guard() wraps a function so it only runs once
// cleared. Works anywhere fetch exists (Node 18+, edge, browser).

export type Verdict = 'auto' | 'review' | 'dual_review' | 'reject'
// gate() answers cleared / rejected / pending (/ sent_back on resubmit); status()
// and wait() can also see escalated, expired, and (CLE-201) revoked / withdrawn.
export type GateStatus = 'cleared' | 'rejected' | 'pending' | 'sent_back' | 'escalated' | 'expired' | 'revoked' | 'withdrawn'

// Receipt TYPES only — the verifier itself lives on the Node-only subpath
// `@clearedby/sdk/receipt` (it needs node:crypto; this entry stays universal).
import type { AuthorizationReceipt, ReceiptStatusView } from './receipt'
export type {
  AuthorizationReceipt,
  ReceiptAgent,
  ReceiptStatus,
  ReceiptStatusView,
  VerifyReceiptOptions,
  VerifyReceiptResult,
} from './receipt'

export interface ClearedByOptions {
  /**
   * API key, e.g. `cb_live_…`. A partner key (`cb_partner_…`) works for the
   * read methods (list / get / permissions / status) with an `orgId`.
   */
  apiKey: string
  /** Defaults to https://app.clearedby.com */
  baseUrl?: string
  /** Inject a fetch impl (tests / non-global-fetch runtimes). */
  fetch?: typeof fetch
}

/**
 * The agent's structured case for an action (CLE-96/97). Entirely optional and
 * backward-compatible: omit it and the gate still works. When present, the
 * reviewer sees a Proof Case panel — recommended outcome, confidence, reason,
 * risk flags, and friendly evidence cards (see {@link Evidence}).
 *
 * ClearedBy never verifies the *truth* of a proof case — it presents your case
 * to a human and pins it, tamper-evident, to their decision. The cards are your
 * assertions; the reviewer rules on them.
 *
 * CLE-204: every evidence item in a proof is stored with provenance
 * `agent_claim`, whatever you send, and the reviewer sees it badged
 * "Agent says". Evidence only counts as verified when a partner's backend
 * attaches it ({@link ClearedByPartner.attachEvidence}) or ClearedBy computes
 * it — which is what a policy's `requires_verified` checks.
 */
export interface ProofCase {
  /** Plain-language reason this action should happen. */
  reason?: string
  /** 0..1 — the agent's own confidence. Shown as "agent confidence N%". */
  confidence?: number
  /** e.g. 'approve_refund'. Rendered as a "recommends ·" pill. */
  recommended_outcome?: string
  /** What the human should weigh, e.g. ['high_value', 'first_order']. */
  risk_flags?: string[]
  /** Typed evidence cards rendered in the reviewer's dossier. */
  evidence?: Evidence[]
}

/**
 * One piece of evidence. ClearedBy renders a friendly card for each known
 * `type` below; any other `type` falls back to a generic key/value card — so
 * you can always invent your own and it still shows.
 */
export type Evidence = (
  | { type: 'threshold'; value: ThresholdEvidence }
  | { type: 'entity'; value: EntityEvidence }
  | { type: 'timeline'; value: TimelineEntry[] }
  | { type: 'table'; value: TableEvidence }
  | { type: 'media'; value: MediaEvidence }
  | { type: 'source'; value: SourceEvidence }
  | { type: 'conversation'; value: ConversationEvidence }
  | { type: 'note'; value: string }
  | { type: string; value: unknown }
) & {
  /** Short caption shown beside the card's provenance badge. */
  label?: string
  /**
   * Layout hint in the reviewer's dossier. 'half' lets the card pair beside
   * another half card; 'full' takes the whole row. Omit for a sensible default:
   * threshold/entity render 'half', everything else 'full'. Narrow widths stack
   * regardless.
   */
  width?: 'half' | 'full'
}

/** A measured value against a limit — renders as a labelled bar. */
export interface ThresholdEvidence {
  label: string
  value: number
  limit?: number
  unit?: string
  status?: 'ok' | 'warn' | 'over'
}
/** A profile card — a customer, an order, an account. */
export interface EntityEvidence {
  name: string
  subtitle?: string
  fields?: { label: string; value: string | number }[]
  badges?: { label: string; tone?: 'ok' | 'warn' | 'risk' }[]
}
/** One event in a timeline card. */
export interface TimelineEntry {
  label: string
  /** ISO timestamp; shown right-aligned. */
  at?: string
  detail?: string
}
/** Tabular evidence — line items, comparisons. */
export interface TableEvidence {
  columns: string[]
  rows: (string | number)[][]
}
/** An image — a screenshot or photo. Give an https URL or a data: URL. */
export interface MediaEvidence {
  url?: string
  dataUrl?: string
  caption?: string
}
/** A citation — a support thread, a dispute, a source document. */
export interface SourceEvidence {
  title?: string
  url?: string
  snippet?: string
  /**
   * @deprecated CLE-204 — ignored. An agent can't mark its own evidence
   * verified: everything in a proof is shown as "Agent says". Have the
   * partner's backend attach verified facts with ClearedByPartner.attachEvidence.
   */
  verified?: boolean
}

/** CLE-204: who vouches for a piece of evidence. */
export type EvidenceProvenance = 'agent_claim' | 'partner_verified' | 'clearedby_computed'

/** One evidence item as ClearedBy serves it back (detail view, attach response). */
export interface StoredEvidence {
  /** Set on partner-attached items. */
  id?: string
  type: string
  value: unknown
  label?: string
  source_ref?: string
  width?: 'half' | 'full'
  /** `agent_claim` = the agent said so; `partner_verified` = your backend attached it; `clearedby_computed` = ClearedBy derived it. */
  provenance: EvidenceProvenance
  /** null for agent claims; `partner:<id>` or `clearedby`. */
  verified_by: string | null
  /** The partner's display name, for partner_verified items. */
  verifier_name?: string
  verified_at: string | null
  /** sha256 hex of canonicalJSON(value). */
  sha256: string
  /**
   * Detail view only, partner items: `ok` = the value still hashes to what the
   * chain committed when it was attached; `mismatch` = altered since;
   * `uncommitted` = no evidence attestation names it.
   */
  integrity?: 'ok' | 'mismatch' | 'uncommitted'
}

/** A partner-verified fact to attach to a held item. */
export interface AttachEvidenceItem {
  /** 1-64 chars of A-Z a-z 0-9 _ . : - — the name a policy's `requires_verified` uses, e.g. 'order_lookup'. */
  type: string
  value: unknown
  label?: string
  /** Your reference for where the fact came from, e.g. a Shopify order GID. */
  source_ref?: string
}

export interface AttachEvidenceResult {
  work_item_id: string
  items: StoredEvidence[]
  /** The `evidence` attestation committing the hashes (null for dashboard test items). */
  attestation: { seq: number; hash: string } | null
}
/** A chat / support thread — renders as a message-bubble transcript. */
export interface ConversationEvidence {
  title?: string
  messages: ConversationMessage[]
}
export interface ConversationMessage {
  /** Sender label; 'customer' vs 'agent'/'support'/'system' drives bubble side + tint. */
  from?: string
  /** Message text. Optional — a message can be image-only. */
  text?: string
  /** An attached image (https or data: URL) — e.g. a photo the customer sent. */
  image?: string
  /** ISO timestamp or short label, shown under the bubble. */
  at?: string
}

/**
 * Caller context for a gate call. Free-form (any extra keys are kept and shown
 * to reviewers), with a few keys ClearedBy gives meaning to. Keys starting
 * `cb_` are server-owned and stripped.
 */
export interface GateContext {
  /**
   * CLE-212: the data subject this action is about (e.g. a Shopify customer
   * GID). It is what makes their data erasable (`eraseSubject`). Required in
   * partner orgs for shopper-related actions (422 `subject_id_required`);
   * elsewhere a missing one comes back as `warnings: ['subject_id_missing']`.
   */
  subject_id?: string
  /** Groups related items; filter on it with `list({ batchId })`. */
  batch_id?: string
  /**
   * Partner orgs: YOUR id (external_subject) for the person whose tool proposed
   * the action. That person can then never be one of its dual-review approvers.
   */
  requested_by_subject?: string
  /** One-line summary shown to reviewers. */
  summary?: string
  [key: string]: unknown
}

/** Per-call on_decision URL overrides (CLE-138): where each verdict is dispatched. */
export interface OnDecisionOverrides {
  cleared?: { url: string }
  rejected?: { url: string }
  expired?: { url: string }
  sent_back?: { url: string }
}

export interface GateInput {
  action: string
  params?: Record<string, unknown>
  context?: GateContext
  /** The agent's case for this action — shown to the reviewer. */
  proof?: ProofCase
  /** Named policy; omit to use the org default. */
  policy?: string
  /**
   * The relying party this authorization is FOR (CLE-198) — e.g. the MCP
   * server or partner API that will verify the receipt. Reviewers see it,
   * policy can check it (`context.audience`), and the signed receipt is then
   * valid only for that audience.
   */
  audience?: string
  mode?: 'enforce' | 'shadow'
  /** Webhook to resume on when held. */
  callbackUrl?: string
  /** Wire-name alias of `callbackUrl` (the HTTP field name). */
  callback_url?: string
  /**
   * Per-call on_decision URL overrides (CLE-138): send this item's verdict to
   * these URLs instead of the policy's / partner's defaults. Only URLs: the
   * policy's outbound credential is never sent to an override URL.
   */
  onDecision?: OnDecisionOverrides
  /** Wire-name alias of `onDecision`. */
  on_decision?: OnDecisionOverrides
  /** Seconds, or a duration string like "1h". */
  timeout?: number | string
  /** Resubmit a sent-back item (CLE-140): the parent item id to link to. */
  parentItemId?: string
  /**
   * Sent as the `Idempotency-Key` header. Retrying with the same key (within
   * 24h) replays the first response instead of gating the action twice — use a
   * stable key per logical action (e.g. your own operation id). Reusing a key
   * with a different request body is rejected (422 `idempotency_key_reused`).
   */
  idempotencyKey?: string
  /**
   * Checked undo (CLE-210): the id of the executed work item this proposal
   * undoes. ClearedBy checks it (same org, cleared, completed, and this action
   * is the catalogue inverse) and policies can match it as `reverts`. Build
   * the whole input with `clearedby.buildUndo(id)`.
   */
  reverts?: string
}

/** One signed attestation row from the ledger (GET /v1/ledger). */
export interface LedgerRow {
  seq: number
  id: string
  kind: string
  actor: string
  work_item_id: string | null
  payload: Record<string, unknown>
  prev_hash: string
  hash: string
  signature: string
  key_id: string
  created_at: string
}

/** A page of the ledger, newest first. */
export interface LedgerPage {
  rows: LedgerRow[]
  /** Pass as `cursor` for the next (older) page; null on the last page. */
  next_cursor: number | null
  /** @deprecated Alias of `rows`, kept for pre-0.x callers. Use `rows`. */
  entries: LedgerRow[]
}

/** Per-item result for a batch action (CLE-210), keyed like `params.changes[]`. */
export interface CompletionItem {
  /** The change's key: product_id / variant_id GID, or `<inventory_item_id>@<location_id>`. */
  key: string
  status: 'done' | 'failed' | 'skipped'
  /** The live value before you changed it — what an undo restores. */
  before?: unknown
  /** The value you wrote — compared with the approved `after`. */
  after?: unknown
  external_ref?: string
  error?: string
}

export interface CompleteInput {
  status: 'done' | 'failed' | 'partial'
  /**
   * Idempotency key (CLE-210). Retrying with the same key and body returns the
   * stored result (`idempotent_replay: true`); the same key with a different
   * body is a 409 `completion_conflict`. Sent as the Idempotency-Key header.
   */
  completionId?: string
  executedParams?: Record<string, unknown>
  externalRef?: string
  evidence?: { type: string; value: unknown }[]
  result?: unknown
  /** Per-item results (max 10,000 per call). */
  items?: CompletionItem[]
  /** receipt_id of the per-attempt delivery receipt you verified (dispatch v2). */
  deliveryReceiptId?: string
}

export interface CompleteResult {
  recorded: boolean
  tier: 1 | 2 | 3
  diverged: boolean
  status: string
  seq?: number
  hash?: string
  completion_id?: string
  idempotent_replay?: boolean
  receipt_id?: string
  receipt_hash?: string
  delivery_receipt_id?: string
  /** Counts for this call's items. */
  items?: { reported: number; done: number; failed: number; skipped: number; unknown: number }
  /** Running totals over every report for the item. */
  totals?: { approved: number; done: number; failed: number; skipped: number; unreported: number }
}

/** What `buildUndo()` returns: a gate input ready to submit, plus the keys being undone. */
export interface UndoInput extends GateInput {
  params: Record<string, unknown>
  reverts: string
  keys: string[]
}

export interface GateResult {
  id: string
  status: GateStatus
  rule?: string
  sampled?: boolean
  /** shadow mode: what would have happened. */
  shadow?: boolean
  would?: { verdict: Verdict; rule: string }
  decided_by?: string
  expires_at?: string
  routed_to?: string[]
  attestation?: { seq: number; hash: string; signature?: string }
  /**
   * Portable signed Authorization Receipt (CLE-198) — present on enforce-mode
   * cleared verdicts. Hand it to the relying party; they verify it offline
   * with `verifyReceipt` from `@clearedby/sdk/receipt` (Node) and ClearedBy's
   * published keys. Expires ~10 minutes after issuance — use it promptly.
   */
  receipt?: AuthorizationReceipt
  resume?: { mode: 'poll' | 'webhook'; poll?: string; wait?: string; callback_url?: string; signing_secret?: string }
  reason?: string | null
  /** Revise chain position (CLE-140): 1 = original, N = the Nth resubmission. */
  attempt?: number
  parent_item_id?: string | null
  /** CLE-201: when the approval was revoked (status 'revoked'). */
  revoked_at?: string
  /** CLE-201: when the request was withdrawn (status 'withdrawn'). */
  withdrawn_at?: string
  /**
   * CLE-221: a dashboard test item. It is never on the ledger and never
   * authorizes anything, even when `status` is 'cleared'. guard() refuses it.
   */
  test?: boolean
  /** CLE-212: non-fatal problems with the request, e.g. 'subject_id_missing'. */
  warnings?: SubjectWarning[]
}

/** CLE-212: why a request's `context.subject_id` is flagged (self-serve orgs; partner orgs get a 422). */
export type SubjectWarning = 'subject_id_missing' | 'subject_id_invalid'

/** POST /v1/gate?dry=1: what the policy WOULD do. Nothing is stored. */
export interface CheckResult {
  dry: true
  verdict: Verdict
  rule: string
  sampled: boolean
  trace?: unknown
  policy?: { name: string; version: number }
  currency?: { code: string; source: 'policy' | 'org' | 'default' }
  warnings?: SubjectWarning[]
}

/** CLE-201: what happened to the item's on_decision.cleared delivery when it was revoked. */
export type RevokeDispatchOutcome = 'none' | 'cancelled' | 'in_flight' | 'delivered' | 'gave_up'

/** POST /v1/gate/:id/revoke (CLE-201). */
export interface RevokeResult {
  id: string
  status: 'revoked'
  revoked_at: string
  /** 'user:<id>' | 'api:<key prefix>' | 'partner:<id>' */
  revoked_by: string
  /**
   * 'cancelled': a queued delivery was stopped. 'in_flight' / 'delivered': the
   * receiver may already have it, and must check the receipt status before executing.
   */
  dispatch: RevokeDispatchOutcome
  /** A `partial` completion existed: the revoke stops the remaining items. */
  stopped_partial: boolean
  attestation?: { seq: number; hash: string }
}

/** POST /v1/gate/:id/withdraw (CLE-201). */
export interface WithdrawResult {
  id: string
  status: 'withdrawn'
  withdrawn_at: string
  withdrawn_by: string
  attestation?: { seq: number; hash: string }
}

/** One action in the catalogue (GET /v1/catalogue, CLE-213). */
export interface CatalogueAction {
  action: string
  title: string
  description: string
  /** Batch actions carry `changes[]` (each with before + after) and `count`. */
  batch: boolean
  /** reversible: undo = same action, before/after swapped. compensable: undo = a different action. irreversible: no undo. */
  reversibility: 'reversible' | 'compensable' | 'irreversible'
  inverse: { action: string; strategy: 'swap_before_after' | 'compensate'; note: string } | null
  /** Cross-field rules the JSON schema can't express (the gate enforces them). */
  rules: string[]
  /** JSON Schema (2020-12) for `params`. */
  params_schema: Record<string, unknown>
  /** Recommended evidence cards (`type` from the Evidence vocabulary above). */
  evidence: { type: string; shows: string }[]
  example: Record<string, unknown>
}

export interface ActionCatalogue {
  /** Pin against this; it changes when a schema changes shape. */
  version: string
  namespace: string
  conventions: { store: string; ids: string; batch: string; batch_soft_cap: number; money: string }
  actions: CatalogueAction[]
}

// ---- Read API (CLE-208): list / detail / permissions for embedded review UIs ----

export type ItemStatus = 'pending' | 'escalated' | 'cleared' | 'rejected' | 'expired' | 'sent_back' | 'revoked' | 'withdrawn'
export type DecisionVerb = 'clear' | 'reject' | 'send_back' | 'escalate'
export type IncludeOption = 'params' | 'proof' | 'context' | 'lineage' | 'events'

/** A person in an org. `external_subject` is the partner's id for them (null for non-provisioned users). */
export interface Person {
  user_id: string
  external_subject: string | null
  name: string
}

/** One clearance as a review UI renders it (GET /v1/gate, GET /v1/gate/:id/detail). */
export interface Clearance {
  id: string
  status: ItemStatus
  action: string
  mode: 'enforce' | 'shadow'
  rule: string
  policy: { id: string; name: string | null; version: number }
  sampled: boolean
  summary: string | null
  /** The exact proposed change. Always on detail; on list only with include=params. */
  params?: Record<string, unknown>
  proof?: ProofCase | null
  /**
   * CLE-204 (whenever `proof` is included): all evidence split by who vouches
   * for it. Render `claims` as "Agent says" and `verified` as "Verified by
   * <verifier_name>" / "Checked by ClearedBy".
   */
  evidence?: { claims: StoredEvidence[]; verified: StoredEvidence[] }
  /** Caller context minus ClearedBy's internal keys. */
  context?: Record<string, unknown>
  batch_id: string | null
  audience: string | null
  requires_passkey: boolean
  attempt: number
  parent_item_id: string | null
  children?: { id: string; status: ItemStatus; attempt: number; created_at: string }[]
  /** Reviewers whose current authority covers this item, plus a named escalation target. */
  routed_to: Person[]
  channels: string[]
  escalation: { to: Person | null; at: string | null; reason: string | null } | null
  dual_review: { required: number; approvals: Person[] } | null
  expires_at: string | null
  verdict_source: string | null
  decided_by: Person | null
  decided_at: string | null
  reason: string | null
  receipt?: AuthorizationReceipt
  receipt_redacted?: true
  completion: { status: string | null; ref: string | null; completed_at: string; diverged: boolean } | null
  dispatch: Record<string, { delivered: boolean; gave_up: boolean; needs_attention: boolean; attempts: number }> | null
  created_at: string
  updated_at: string
  /** Only with include=events on get(). */
  events?: ClearanceEvent[]
}

export interface ClearanceEvent {
  work_item_id: string
  id: string
  kind: string
  at: string
  actor: { type: 'user' | 'policy' | 'system' | 'agent' | 'partner'; ref: string | null; user_id?: string; external_subject?: string | null; name?: string } | null
  target?: Person | null
  data: Record<string, unknown>
}

export interface ListOptions {
  status?: ItemStatus | ItemStatus[]
  /** A reviewer's external_subject: items routed to (authority covers) or escalated to them. */
  reviewer?: string
  actionPrefix?: string
  batchId?: string
  cursor?: string
  limit?: number
  include?: IncludeOption[]
  /** A reviewer's ClearedBy user id, instead of `reviewer` (for people with no external_subject). */
  reviewerUserId?: string
  /** Required when authenticating with a partner key (`cb_partner_…`). */
  orgId?: string
}

export interface Permissions {
  id: string
  status: ItemStatus
  reviewer: Person
  can: DecisionVerb[]
  cannot: { decision: DecisionVerb; status: number; code: string; message: string; hint?: string }[]
  requires_passkey: boolean
  reason_required: DecisionVerb[]
  dual_review: { required: number; approvals: string[] } | null
  send_back_forces?: 'reject' | 'escalate'
}

// ---- Errors ----

/**
 * Every non-2xx answer from the ClearedBy API (and a `wait()` timeout, status
 * 408 / code 'timeout'). `code` is the API's stable `error.code` (e.g.
 * `no_authority`, `subject_id_required`); `message` its `error.message`;
 * `details` its structured `error.details` (or any extra fields on the error
 * envelope); `hint` its `error.hint`; `body` the raw response JSON.
 *
 * `ClearedByError` is the same class under its older name: `instanceof` works
 * with either.
 */
export class ClearedByApiError extends Error {
  /** Structured detail from the error envelope, when there is any. */
  readonly details: Record<string, unknown> | undefined
  /** The API's suggestion for fixing the call, when it gave one. */
  readonly hint: string | undefined

  constructor(message: string, readonly status: number, readonly code?: string, readonly body?: unknown) {
    super(message)
    this.name = 'ClearedByApiError'
    const env = errorEnvelope(body)
    this.hint = typeof env?.hint === 'string' ? env.hint : undefined
    if (env !== null && env.details !== null && typeof env.details === 'object') {
      this.details = env.details as Record<string, unknown>
    } else if (env !== null) {
      const { code: _c, message: _m, hint: _h, details: _d, ...rest } = env
      this.details = Object.keys(rest).length > 0 ? rest : undefined
    } else {
      this.details = undefined
    }
  }
}

/** The older name of {@link ClearedByApiError}: the same class. */
export const ClearedByError = ClearedByApiError
export type ClearedByError = ClearedByApiError

function errorEnvelope(body: unknown): Record<string, unknown> | null {
  if (body === null || typeof body !== 'object') return null
  const e = (body as { error?: unknown }).error
  return e !== null && typeof e === 'object' ? (e as Record<string, unknown>) : null
}

function apiError(status: number, json: any, what: string): ClearedByApiError {
  return new ClearedByApiError(json?.error?.message ?? `${what} failed (${status})`, status, json?.error?.code, json)
}

/** Thrown by guard() when the policy (or a reviewer) rejects the action. */
export class RejectedError extends Error {
  constructor(readonly result: GateResult) {
    super(`Action rejected${result.reason ? `: ${result.reason}` : ''}`)
    this.name = 'RejectedError'
  }
}

/**
 * Thrown by guard() when a reviewer sends the action back to revise (CLE-140).
 * `reason` is the revision instruction; `result.id` is the parent to resubmit
 * against once you've regenerated. Catch it, regenerate, then call
 * `clearedby.resubmit(result.id, { ...revisedInput })`.
 */
export class SentBackError extends Error {
  readonly reason: string | null
  constructor(readonly result: GateResult) {
    super(`Action sent back to revise${result.reason ? `: ${result.reason}` : ''}`)
    this.name = 'SentBackError'
    this.reason = result.reason ?? null
  }
}

/**
 * Thrown by guard() when the clearance is a dashboard test item (CLE-221).
 * Test items are never on the ledger and never authorize an action, so `fn`
 * does not run, even if a reviewer approved it.
 */
export class TestItemError extends Error {
  constructor(readonly result: GateResult) {
    super(`Clearance ${result.id} is a test item and does not authorize any action`)
    this.name = 'TestItemError'
  }
}

const DEFAULT_BASE = 'https://app.clearedby.com'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---- Shared HTTP plumbing ----

type QueryValue = string | number | boolean | null | undefined
type Query = Record<string, QueryValue>

function buildQuery(q: Query | undefined): string {
  if (q === undefined) return ''
  const parts: string[] = []
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null || v === '') continue
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
  }
  return parts.length === 0 ? '' : `?${parts.join('&')}`
}

const seg = (s: string | number): string => encodeURIComponent(String(s))

interface RequestOptions {
  body?: unknown
  query?: Query
  headers?: Record<string, string>
  /** Accepted statuses (default [200]). */
  ok?: number[]
  /** Overrides the client's own key (decision / read tokens). */
  bearer?: string
  /** Label for the fallback error message. */
  what: string
}

class Transport {
  readonly baseUrl: string
  private readonly fetchImpl: typeof fetch

  constructor(private readonly key: string, baseUrl: string | undefined, f: typeof fetch | undefined, who: string) {
    this.baseUrl = (baseUrl ?? DEFAULT_BASE).replace(/\/$/, '')
    const impl = f ?? (globalThis.fetch as typeof fetch | undefined)
    if (!impl) throw new Error(`${who}: no fetch available — pass options.fetch`)
    this.fetchImpl = impl
  }

  async raw(method: string, path: string, o: Omit<RequestOptions, 'what' | 'ok'> = {}): Promise<{ status: number; json: any }> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}${buildQuery(o.query)}`, {
      method,
      headers: {
        authorization: `Bearer ${o.bearer ?? this.key}`,
        ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(o.headers ?? {}),
      },
      ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}),
    })
    const json = await res.json().catch(() => ({}))
    return { status: res.status, json }
  }

  async request<T>(method: string, path: string, o: RequestOptions): Promise<T> {
    const { status, json } = await this.raw(method, path, o)
    if (!(o.ok ?? [200]).includes(status)) throw apiError(status, json, o.what)
    return json as T
  }
}

// ---- Org-key response types ----

/** One on_decision delivery row (GET /v1/gate/:id/delivery, CLE-209). */
export interface DeliveryView {
  /** `<work_item_id>:<verdict>`; stable across redeliveries. */
  delivery_id: string
  verdict: 'cleared' | 'rejected' | 'expired' | 'sent_back'
  format: string | null
  attempts: number
  delivered: boolean
  /** The receiver answered 409: it had already executed it. */
  already_executed: boolean
  last_status: number | null
  last_error: string | null
  last_attempt_at: string | null
  next_retry_at: string | null
  in_flight: boolean
  gave_up: boolean
  needs_attention: boolean
  receipt_id: string | null
  completion_tier: number | null
  /** 'revoked' when a revoke stopped the delivery (CLE-201). */
  cancelled: 'revoked' | null
}

export interface DeliveryState {
  id: string
  status: ItemStatus
  /** The row for the item's CURRENT verdict (null when nothing was dispatched). */
  delivery: DeliveryView | null
  /** Every verdict that has a row. */
  deliveries: DeliveryView[]
}

/** GET /v1/ledger/verify: the org's chain re-walked from genesis. */
export type LedgerVerifyResult =
  | { intact: true; through: number; rows: number }
  | { intact: false; broken_at: number; reason: string; rows: number }

/** One policy name with its versions (GET /v1/policies). Never includes rules. */
export interface PolicyListEntry {
  name: string
  active_version: number | null
  latest_version: number
  updated_at: string
}

/** A policy's shape (GET /v1/policies/:name): what to send, never the thresholds. */
export interface PolicyShape {
  name: string
  version: number
  /** Action patterns this policy governs, e.g. 'refund.create', 'payout.*'. */
  actions: string[]
  /** Every params/context field the policy reads (names only). */
  fields: string[]
  by_action: { action: string; fields: string[]; expects?: { name: string; type: string; description: string; subject?: boolean }[] }[]
  /** The currency to send amounts in (params.currency). */
  currency: string
}

/** One stored policy version (GET /v1/policies/:name/:version). */
export interface PolicyVersion {
  id: string
  name: string
  version: number
  status: 'draft' | 'active' | 'archived' | (string & {})
  yaml: string
  compiled: unknown
  activated_at: string | null
  created_at: string
}

export interface PolicyLintFinding {
  level: 'error' | 'warn'
  code: string
  ruleRef: string
  message: string
  fix?: string
  relatedRefs?: string[]
}

/** POST /v1/policies/:name. `saved: false` = blocked by compile or lint errors (nothing stored). */
export interface SavePolicyDraftResult {
  saved: boolean
  id?: string
  name: string
  version?: number
  status?: 'draft'
  lint: PolicyLintFinding[]
  compile_errors?: { path: string; message: string }[]
}

export interface SimulateChange {
  id: string
  action: string
  oldVerdict: Verdict
  newVerdict: Verdict
  newRule: string
}

/** POST /v1/policies/:name/:version/simulate: that version replayed over recent history. */
export interface SimulateResult {
  total: number
  counts: { old: Record<Verdict, number>; new: Record<Verdict, number> }
  /** Items the version would let through more easily. */
  loosened: SimulateChange[]
  tightened: SimulateChange[]
  window_days: number
  currency: { currency: string; source: 'policy' | 'org' | 'default' }
}

export type WebhookEvent =
  | 'decision.cleared'
  | 'decision.rejected'
  | 'decision.expired'
  | 'decision.completed'
  | 'graduation.proposed'
  | 'decision.pending'
  | 'decision.escalated'
  | 'decision.sent_back'
  | 'decision.revoked'
  | 'decision.withdrawn'

export type WebhookSource = 'zapier' | 'make' | 'n8n' | 'api'

export interface CreateWebhookInput {
  /** Public https URL (private / loopback addresses are refused). */
  url: string
  events: WebhookEvent[]
  filters?: { action_prefix?: string; policy?: string; mode?: 'enforce' | 'shadow' }
  source?: WebhookSource
}

export interface Webhook {
  id: string
  url: string
  events: WebhookEvent[]
  filters: { action_prefix?: string; policy?: string; mode?: string }
  source: WebhookSource
  active: boolean
  /** Consecutive failed deliveries (list only). The 21st deactivates the subscription. */
  failed_count?: number
  created_at?: string
}

/** GET /v1/signing-secrets (CLE-209): what verifies what ClearedBy sends you. */
export interface SigningSecrets {
  org_id: string
  /** For on_decision dispatches without an outbound credential (incl. partner execution_url / notify_url). */
  on_decision: { secret: string; applies_to: string; header: string }
  /** For per-item callback_url deliveries (same value as `resume.signing_secret`). */
  callback: { secret: string; applies_to: string; header: string }
  rotation: string
}

/** GET /v1/stats: throughput over a window. */
export interface OrgStats {
  window_days: number
  org: {
    total_gated: number
    auto_cleared: number
    auto_clear_rate: number
    human_cleared: number
    held: number
    rejected: number
    sent_back: number
    expired: number
    shadow_would_hold: number
  }
  reviewers: { user: string; cleared: number; rejected: number; sent_back: number; median_minutes: number | null }[]
}

/** GET /v1/usage: the current billing period. `over_quota` never blocks a gate. */
export interface Usage {
  period: unknown
  plan: string
  billed_unit: string
  used: number
  included: number | null
  remaining: number | null
  over_quota: boolean
  usage_ratio: number | null
  breakdown: {
    gated: number
    auto_cleared: number
    human_cleared: number
    rejected: number
    sent_back: number
    expired: number
    held: number
    shadow: number
  }
}

/** A graduation proposal (GET /v1/graduation): a rule that could safely loosen. Ratified in the dashboard. */
export interface GraduationProposal {
  id: string
  policy_name: string
  rule_ref: string
  evidence: Record<string, unknown>
  proposed_change: Record<string, unknown>
  status: 'open' | 'ratified' | 'dismissed' | (string & {})
  resolved_by: string | null
  resolved_at: string | null
  created_at: string
}

function gateBody(input: GateInput): Record<string, unknown> {
  const callbackUrl = input.callbackUrl ?? input.callback_url
  const onDecision = input.onDecision ?? input.on_decision
  return {
    action: input.action,
    params: input.params ?? {},
    context: input.context ?? {},
    ...(input.proof ? { proof: input.proof } : {}),
    ...(input.policy ? { policy: input.policy } : {}),
    ...(input.audience ? { audience: input.audience } : {}),
    ...(input.mode ? { mode: input.mode } : {}),
    ...(callbackUrl ? { callback_url: callbackUrl } : {}),
    ...(input.timeout !== undefined ? { timeout: input.timeout } : {}),
    ...(input.parentItemId ? { parent_item_id: input.parentItemId } : {}),
    ...(input.reverts ? { reverts: input.reverts } : {}),
    ...(onDecision ? { on_decision: onDecision } : {}),
  }
}

function listQuery(opts: ListOptions): Query {
  return {
    status: opts.status === undefined ? undefined : Array.isArray(opts.status) ? opts.status.join(',') : opts.status,
    reviewer: opts.reviewer,
    reviewer_user_id: opts.reviewerUserId,
    action_prefix: opts.actionPrefix,
    batch_id: opts.batchId,
    cursor: opts.cursor,
    limit: opts.limit,
    include: opts.include && opts.include.length > 0 ? opts.include.join(',') : undefined,
    org_id: opts.orgId,
  }
}

const includeQ = (include: IncludeOption[] | undefined): string | undefined =>
  include && include.length > 0 ? include.join(',') : undefined

/**
 * The org client. Authenticate with the org's `cb_live_` key (a partner gets one
 * from `ClearedByPartner.createOrg` / `createOrgKey`). The read methods (status,
 * list, get, events, permissions, signingSecrets) also accept a partner key
 * with `orgId`, though `ClearedByPartner` has the same reads with the org first.
 */
export class ClearedBy {
  private readonly t: Transport

  constructor(opts: ClearedByOptions) {
    if (!opts?.apiKey) throw new Error('ClearedBy: apiKey is required')
    this.t = new Transport(opts.apiKey, opts.baseUrl, opts.fetch, 'ClearedBy')
  }

  // ---- Propose ----

  /** Gate an action. Returns the verdict (cleared / rejected / pending). */
  async gate(input: GateInput): Promise<GateResult> {
    return this.t.request<GateResult>('POST', '/v1/gate', {
      body: gateBody(input),
      headers: input.idempotencyKey ? { 'idempotency-key': input.idempotencyKey } : {},
      ok: [200, 202],
      what: 'gate',
    })
  }

  /**
   * Resubmit a sent-back item with revised params (CLE-140). Links the new
   * attempt to `parentItemId` so the whole revise chain is one auditable
   * lineage. Subject to the policy's revision cap — after the cap, the gate
   * forces a terminal verdict instead of holding for review again. Each
   * sent-back item accepts exactly ONE resubmission (409
   * `parent_already_resubmitted` after that), and `action` must match the
   * parent's — pass `idempotencyKey` so a network retry replays instead of 409ing.
   */
  async resubmit(parentItemId: string, input: GateInput): Promise<GateResult> {
    return this.gate({ ...input, parentItemId })
  }

  /**
   * Dry-run a gate call (POST /v1/gate?dry=1): evaluate and return the verdict
   * WITHOUT persisting a work item or attestation. Use to preview what a policy
   * would do for an action+params.
   */
  async check(input: GateInput): Promise<CheckResult> {
    return this.t.request<CheckResult>('POST', '/v1/gate', {
      query: { dry: 1 },
      body: {
        action: input.action,
        params: input.params ?? {},
        context: input.context ?? {},
        ...(input.policy ? { policy: input.policy } : {}),
        ...(input.reverts ? { reverts: input.reverts } : {}),
      },
      what: 'check',
    })
  }

  /**
   * Gate `action`, and only run `fn` if it clears (now or after a human
   * approves). Throws RejectedError if rejected, SentBackError if a reviewer
   * sends it back to revise (catch it, regenerate, and call resubmit()),
   * ClearedByApiError on timeout, TestItemError for a test item (CLE-221: never
   * executable). In shadow mode nothing blocks — `fn` always runs.
   */
  async guard<T>(input: GateInput, fn: () => Promise<T> | T): Promise<T> {
    const r = await this.gate(input)
    if (r.test === true) throw new TestItemError(r)
    if (r.shadow) return await fn()
    if (r.status === 'cleared') return await fn()
    if (r.status === 'rejected') throw new RejectedError(r)
    if (r.status === 'sent_back') throw new SentBackError(r)
    const settled = await this.wait(r.id, { timeoutMs: 60 * 60_000 })
    if (settled.test === true) throw new TestItemError(settled)
    if (settled.status === 'cleared') return await fn()
    if (settled.status === 'sent_back') throw new SentBackError(settled)
    // rejected, expired, revoked, withdrawn: nothing is authorized.
    throw new RejectedError(settled)
  }

  // ---- Follow ----

  /** Current state of a gated item (GET /v1/gate/:id). */
  async status(id: string, opts: { orgId?: string } = {}): Promise<GateResult> {
    return this.t.request<GateResult>('GET', `/v1/gate/${seg(id)}`, { query: { org_id: opts.orgId }, what: 'status' })
  }

  /**
   * Block until a held item reaches a terminal state (cleared / rejected /
   * sent_back) or the timeout elapses. A send-back is terminal for this attempt
   * — wait() returns it (with the reviewer's reason) rather than hanging, so the
   * caller can regenerate and resubmit (CLE-140). A test item comes back with
   * `test: true` (CLE-221): don't act on it, whatever its status.
   *
   * CLE-224: long-polls `GET /v1/gate/:id/wait` (the server holds each request
   * up to 55 s and answers the moment the item settles, or `204` to keep
   * waiting), so a decision arrives within a second or two instead of on the
   * next poll. Falls back to polling `GET /v1/gate/:id` every `pollMs` only if
   * the server has no /wait (404).
   */
  async wait(id: string, opts: { timeoutMs?: number; pollMs?: number } = {}): Promise<GateResult> {
    const deadline = Date.now() + (opts.timeoutMs ?? 5 * 60_000)
    const pollMs = opts.pollMs ?? 2_000
    const timedOut = () => new ClearedByApiError(`wait timed out for ${id}`, 408, 'timeout')
    let longPoll = true
    for (;;) {
      if (longPoll) {
        const started = Date.now()
        const secs = Math.min(55, Math.max(1, Math.ceil((deadline - started) / 1000)))
        const { status, json } = await this.t.raw('GET', `/v1/gate/${seg(id)}/wait`, { query: { timeout: secs } })
        if (status === 404) {
          // No /wait (an old server), or no such item: status() tells them apart.
          longPoll = false
          continue
        }
        if (status === 200) {
          const cur = json as GateResult
          if (cur.status !== 'pending' && cur.status !== 'escalated') return cur
        } else if (status !== 204) {
          throw apiError(status, json, 'wait')
        }
        if (Date.now() >= deadline) throw timedOut()
        // A 204 that came straight back (a proxy, not the long-poll) mustn't spin.
        const elapsed = Date.now() - started
        if (elapsed < pollMs) await sleep(Math.min(pollMs - elapsed, Math.max(0, deadline - Date.now())))
        continue
      }
      const cur = await this.status(id)
      if (cur.status !== 'pending' && cur.status !== 'escalated') return cur
      if (Date.now() >= deadline) throw timedOut()
      await sleep(pollMs)
    }
  }

  /**
   * CLE-201: give back an APPROVED action before it runs (POST /v1/gate/:id/revoke).
   * Your requester key may revoke its own org's cleared items — it only ever
   * reduces authority. Refused with 409 `already_executed` once a final
   * (done/failed) completion exists, and 409 `not_cleared` for anything not
   * cleared. A pending on_decision delivery is stopped and no new receipts are
   * minted; check `dispatch` to see whether the receiver may already have it.
   */
  async revoke(id: string, reason: string): Promise<RevokeResult> {
    return this.t.request<RevokeResult>('POST', `/v1/gate/${seg(id)}/revoke`, { body: { reason }, what: 'revoke' })
  }

  /**
   * CLE-201: pull back a request that is still pending / escalated (POST
   * /v1/gate/:id/withdraw). It leaves every review queue; status 'withdrawn'.
   * 409 `not_pending` once it has been decided (revoke a cleared one instead).
   */
  async withdraw(id: string, reason?: string): Promise<WithdrawResult> {
    return this.t.request<WithdrawResult>('POST', `/v1/gate/${seg(id)}/withdraw`, {
      body: reason === undefined ? {} : { reason },
      what: 'withdraw',
    })
  }

  // ---- Execute & prove ----

  /**
   * Report proof of execution for a decided item (CLE-139). Records a
   * `completion` attestation: what status, what you actually executed (for the
   * authorized-vs-executed divergence check), and an optional verifiable
   * `externalRef` (e.g. a Stripe refund id) that earns the Tier-3 "verifiable"
   * label. This is NOT a verdict — it records execution, decides nothing.
   *
   * CLE-210: only a `cleared` item can be completed (409 `not_cleared`). Pass
   * `completionId` so a retry is safe. A `done` or `failed` report is final
   * (a later new report is 409 `already_completed`); report progress on a big
   * batch with `partial` + `items`, then finish with `done`/`failed`.
   */
  async complete(id: string, input: CompleteInput): Promise<CompleteResult> {
    return this.t.request<CompleteResult>('POST', `/v1/gate/${seg(id)}/complete`, {
      body: {
        status: input.status,
        ...(input.executedParams ? { executed_params: input.executedParams } : {}),
        ...(input.externalRef ? { external_ref: input.externalRef } : {}),
        ...(input.evidence ? { evidence: input.evidence } : {}),
        ...(input.result !== undefined ? { result: input.result } : {}),
        ...(input.items ? { items: input.items } : {}),
        ...(input.deliveryReceiptId ? { delivery_receipt_id: input.deliveryReceiptId } : {}),
      },
      headers: input.completionId ? { 'idempotency-key': input.completionId } : {},
      what: 'complete',
    })
  }

  /**
   * Build the undo for an executed item (CLE-210): fetches the item and its
   * completion (GET /v1/gate/:id/undo) and returns a gate input — the inverse
   * action, only the items reported done with before/after swapped, and
   * `reverts` set — ready for `clearedby.gate(undo)`. Nothing is proposed
   * until you submit it; it then goes through policy like any other change.
   * When you execute the cleared undo, check each item's live value first and
   * skip any that no longer equals the recorded `after`.
   */
  async buildUndo(id: string): Promise<UndoInput> {
    const json = await this.t.request<any>('GET', `/v1/gate/${seg(id)}/undo`, { what: 'buildUndo' })
    return { action: json.action, params: json.params, reverts: json.reverts, keys: json.keys ?? [] }
  }

  /**
   * buildUndo(id) and gate() it in one call. `extra` adds anything else the
   * gate takes (context, proof, policy, idempotencyKey, …); action, params and
   * reverts always come from the record.
   */
  async undo(id: string, extra: Omit<GateInput, 'action' | 'params' | 'reverts'> = {}): Promise<GateResult> {
    const u = await this.buildUndo(id)
    return this.gate({ ...extra, action: u.action, params: u.params, reverts: u.reverts })
  }

  /** The on_decision delivery state for an item (GET /v1/gate/:id/delivery, CLE-209). */
  async delivery(id: string): Promise<DeliveryState> {
    return this.t.request<DeliveryState>('GET', `/v1/gate/${seg(id)}/delivery`, { what: 'delivery' })
  }

  /**
   * Re-send the on_decision dispatch for the item's current verdict now
   * (POST /v1/gate/:id/redeliver, CLE-209): the next attempt under the same
   * delivery_id. Rate limited to 1 per item per 30s (429).
   */
  async redeliver(id: string): Promise<{ id: string; delivery: DeliveryView }> {
    return this.t.request('POST', `/v1/gate/${seg(id)}/redeliver`, { what: 'redeliver' })
  }

  /**
   * The stored signed Authorization Receipt for a cleared item (GET
   * /v1/gate/:id/receipt), verbatim. 404 `no_receipt` when there is none,
   * 410 `receipt_redacted` after erasure.
   */
  async receipt(id: string): Promise<AuthorizationReceipt> {
    return this.t.request<AuthorizationReceipt>('GET', `/v1/gate/${seg(id)}/receipt`, { what: 'receipt' })
  }

  /**
   * Is this receipt still good? (GET /v1/receipts/:receipt_id/status, CLE-201.)
   * Public: needs no key, so relying parties can call it too.
   */
  async receiptStatus(receiptId: string): Promise<ReceiptStatusView> {
    return this.t.request('GET', `/v1/receipts/${seg(receiptId)}/status`, { what: 'receipt status' })
  }

  // ---- Read (embedded review UIs) ----

  /**
   * List clearances, newest first (GET /v1/gate). Filter by status, reviewer
   * (external_subject), action prefix or batch id; page with `next_cursor`.
   * With a partner key pass `orgId`.
   */
  async list(opts: ListOptions = {}): Promise<{ items: Clearance[]; next_cursor: string | null }> {
    return this.t.request('GET', '/v1/gate', { query: listQuery(opts), what: 'list' })
  }

  /**
   * Full detail for one clearance (GET /v1/gate/:id/detail): params, proof,
   * context, routing, escalation, dual review, decider, lineage.
   * `include: ['events']` inlines the resolved history. Use status() for the
   * lightweight status shape.
   */
  async get(id: string, opts: { include?: IncludeOption[]; orgId?: string } = {}): Promise<Clearance> {
    return this.t.request<Clearance>('GET', `/v1/gate/${seg(id)}/detail`, {
      query: { include: includeQ(opts.include), org_id: opts.orgId },
      what: 'get',
    })
  }

  /**
   * The item's audit timeline, oldest first (GET /v1/gate/:id/events).
   * `lineage: true` merges the events of the whole revise chain.
   */
  async events(id: string, opts: { lineage?: boolean; orgId?: string } = {}): Promise<ClearanceEvent[]> {
    const json = await this.t.request<{ events: ClearanceEvent[] }>('GET', `/v1/gate/${seg(id)}/events`, {
      query: { include: opts.lineage ? 'lineage' : undefined, org_id: opts.orgId },
      what: 'events',
    })
    return json.events
  }

  /**
   * Which decisions `reviewer` (their external_subject) can make on this item
   * right now, and why not the others — the same checks the decide path runs.
   */
  async permissions(id: string, reviewer: string, opts: { orgId?: string } = {}): Promise<Permissions> {
    return this.t.request<Permissions>('GET', `/v1/gate/${seg(id)}/permissions`, {
      query: { reviewer, org_id: opts.orgId },
      what: 'permissions',
    })
  }

  // ---- Ledger ----

  /**
   * Recent ledger (attestation) rows, newest first. Page older with
   * `cursor: page.next_cursor`.
   */
  async ledger(opts: { limit?: number; cursor?: number } = {}): Promise<LedgerPage> {
    const json = await this.t.request<any>('GET', '/v1/ledger', {
      query: { limit: opts.limit || undefined, cursor: opts.cursor },
      what: 'ledger',
    })
    const rows: LedgerRow[] = Array.isArray(json?.rows) ? json.rows : Array.isArray(json?.entries) ? json.entries : []
    return { rows, next_cursor: json?.next_cursor ?? null, entries: rows }
  }

  /** Re-walk the org's chain from genesis and report the first broken row, if any (GET /v1/ledger/verify). */
  async verifyLedger(): Promise<LedgerVerifyResult> {
    return this.t.request<LedgerVerifyResult>('GET', '/v1/ledger/verify', { what: 'verify ledger' })
  }

  // ---- Catalogue & policies ----

  /**
   * The canonical action catalogue (GET /v1/catalogue, CLE-213): every
   * `shopify.*` action with its params JSON schema, reversibility, inverse
   * (undo) action, recommended evidence cards and an example. The gate enforces
   * the same schemas server-side, so validate against these before calling.
   */
  async catalogue(): Promise<{ shopify: ActionCatalogue }> {
    return this.t.request('GET', '/v1/catalogue', { what: 'catalogue' })
  }

  /** Every policy name with its active and latest version (GET /v1/policies). Never the rules. */
  async listPolicies(): Promise<PolicyListEntry[]> {
    const json = await this.t.request<{ policies: PolicyListEntry[] }>('GET', '/v1/policies', { what: 'list policies' })
    return json.policies
  }

  /** What the active version of a policy reads: actions, field names, currency (GET /v1/policies/:name). */
  async describePolicy(name: string): Promise<PolicyShape> {
    return this.t.request<PolicyShape>('GET', `/v1/policies/${seg(name)}`, { what: 'describe policy' })
  }

  /** One stored version, YAML included (GET /v1/policies/:name/:version). */
  async getPolicy(name: string, version: number): Promise<PolicyVersion> {
    return this.t.request<PolicyVersion>('GET', `/v1/policies/${seg(name)}/${seg(version)}`, { what: 'get policy' })
  }

  /**
   * Save a new DRAFT version from YAML (POST /v1/policies/:name). Compile and
   * lint run first: when they block, this returns `{ saved: false, lint,
   * compile_errors }` rather than throwing. A key can never activate: that is
   * a human (or partner owner-approval) step.
   */
  async savePolicyDraft(name: string, yaml: string): Promise<SavePolicyDraftResult> {
    const { status, json } = await this.t.raw('POST', `/v1/policies/${seg(name)}`, { body: { yaml } })
    if (status === 201 || (status === 422 && json?.saved === false)) return json as SavePolicyDraftResult
    throw apiError(status, json, 'save policy draft')
  }

  /** Replay a stored version over the last `days` (1–90, default 30) of history (POST /v1/policies/:name/:version/simulate). */
  async simulatePolicy(name: string, version: number, opts: { days?: number } = {}): Promise<SimulateResult> {
    return this.t.request<SimulateResult>('POST', `/v1/policies/${seg(name)}/${seg(version)}/simulate`, {
      body: opts.days === undefined ? {} : { days: opts.days },
      what: 'simulate policy',
    })
  }

  // ---- Webhooks (org key only) ----

  /**
   * Subscribe to org events (POST /v1/webhooks). The response carries the
   * signing `secret` ONCE: payloads are HMAC-signed with it.
   */
  async createWebhook(input: CreateWebhookInput): Promise<Webhook & { secret: string }> {
    return this.t.request('POST', '/v1/webhooks', { body: input, ok: [201], what: 'create webhook' })
  }

  /** This org's subscriptions, newest first (GET /v1/webhooks). Secrets are never returned. */
  async listWebhooks(): Promise<Webhook[]> {
    const json = await this.t.request<{ webhooks: Webhook[] }>('GET', '/v1/webhooks', { what: 'list webhooks' })
    return json.webhooks
  }

  /** Unsubscribe (DELETE /v1/webhooks/:id). 404 for an id that isn't this org's. */
  async deleteWebhook(id: string): Promise<{ deleted: true; id: string }> {
    return this.t.request('DELETE', `/v1/webhooks/${seg(id)}`, { what: 'delete webhook' })
  }

  // ---- Org settings & reporting ----

  /**
   * The org's signing secrets (GET /v1/signing-secrets, CLE-209): verify
   * on_decision dispatches (`on_decision.secret`, for `verifyDispatch`) and
   * per-item callbacks (`callback.secret`). Stable per org.
   */
  async signingSecrets(opts: { orgId?: string } = {}): Promise<SigningSecrets> {
    return this.t.request<SigningSecrets>('GET', '/v1/signing-secrets', { query: { org_id: opts.orgId }, what: 'signing secrets' })
  }

  /** Throughput over the last `days` (1–365, default 30), per org and per reviewer (GET /v1/stats). */
  async stats(opts: { days?: number } = {}): Promise<OrgStats> {
    return this.t.request<OrgStats>('GET', '/v1/stats', { query: { days: opts.days }, what: 'stats' })
  }

  /** Current billing-period usage (GET /v1/usage). */
  async usage(): Promise<Usage> {
    return this.t.request<Usage>('GET', '/v1/usage', { what: 'usage' })
  }

  /** Graduation proposals (GET /v1/graduation), open by default. Ratifying is a dashboard action. */
  async graduations(opts: { status?: 'open' | 'ratified' | 'dismissed' | 'all' } = {}): Promise<GraduationProposal[]> {
    const json = await this.t.request<{ proposals: GraduationProposal[] }>('GET', '/v1/graduation', {
      query: { status: opts.status },
      what: 'graduations',
    })
    return json.proposals
  }
}

// ---- Partner helpers (CLE-207) ----
//
// For platforms that EMBED ClearedBy and show held
// actions in their own UI. Your backend holds a `cb_partner_` key; when one of
// your merchant's reviewers decides in your UI you:
//
//   1. createDecisionToken({ orgId, externalSubject })  → a short-lived,
//      single-use `cb_dt_` token that names that reviewer;
//   2. decide(workItemId, { decision, reason }, { token }).
//
// ClearedBy still enforces the reviewer's authority, dual-review distinctness
// and requester ≠ approver. A partner key can never decide directly.

export interface ClearedByPartnerOptions {
  /** Partner key, e.g. `cb_partner_…`. Server-side only. */
  partnerKey: string
  /** Defaults to https://app.clearedby.com */
  baseUrl?: string
  fetch?: typeof fetch
}

export interface DecisionToken {
  token: string
  token_id: string
  expires_at: string
  org_id: string
  user_id: string
  external_subject: string
  work_item_id: string | null
  /** 'decide' (single-use) or 'read' (reusable, read endpoints only). */
  scope?: 'decide' | 'read'
}

export type PartnerDecision = 'clear' | 'reject' | 'escalate' | 'send_back'

export interface PartnerDecideResult {
  status: 'cleared' | 'rejected' | 'pending' | 'escalated' | 'sent_back'
  /** dual_review partials: distinct approvals so far / required. */
  approvals?: number
  required?: number
  attestation?: { seq: number; hash: string }
  receipt?: unknown
  escalatedTo?: { toUserId: string; toName: string } | null
}

// ---- Approval rules (CLE-216) ----
//
// A merchant's "Your approval rules" as knobs + plain English. Tightening is
// yours to apply; loosening waits for a merchant owner/admin to accept.

/** Every knob (see docs/partner-api.md "Approval rules for non-technical merchants"). */
export interface ApprovalRulesSettings {
  /** Tag changes up to N products go through on their own (0 = always ask). */
  tags_auto_max_products: number
  /** Stock updates up to N items go through on their own (0 = always ask). */
  inventory_auto_max_items: number
  price_changes: 'always_review' | 'review_drops_over_pct'
  /** With 'review_drops_over_pct': drops up to this % go through. */
  price_drop_review_pct: number
  discounts: 'always_review'
  /** Refunds up to this amount (major units) go through on their own. */
  refund_auto_max: number
  /** Refunds over this need two people; null = never. */
  refund_dual_above: number | null
  /** Once this much is refunded in 24h, every refund needs an OK; null = no cap. */
  refund_daily_auto_cap: number | null
  /** Refunds on one order adding up past this (30 days) need an OK; null = no cap. */
  refund_per_order_cap: number | null
  order_cancel: 'always_review'
  /** Unanswered requests lapse after this many hours (1–720). */
  timeout_hours: number
  /**
   * Occasional random spot-checks: when on, about `spot_check_pct`% of the
   * actions that would go through on their own are held for an OK anyway.
   * Off by default. Turning it off (or lowering the %) is a loosening, so it
   * waits for a merchant owner/admin.
   */
  spot_checks: boolean
  /** How often, when spot-checks are on: 1–25 (% of automatic verdicts). */
  spot_check_pct: number
}

export interface ApprovalRulesLine {
  key: string
  action_label: string
  sentence: string
}

export interface ApprovalRulesDiff {
  key: string
  action_label: string
  before: string
  after: string
}

export interface ApprovalRulesProposal {
  proposal_id: string
  version: number
  settings: ApprovalRulesSettings
  summary: ApprovalRulesLine[]
  summary_diff: ApprovalRulesDiff[]
  created_at: string
}

export interface ApprovalRules {
  settings: ApprovalRulesSettings | null
  summary: ApprovalRulesLine[]
  active_version: number | null
  currency: string
  refund_approvers: number
  pending_proposal?: ApprovalRulesProposal
}

export type Strictness = 'stricter' | 'equal' | 'looser' | 'mixed'

export type SetRulesResult =
  | { status: 'active'; active_version: number; strictness: Strictness; unchanged: boolean; summary: ApprovalRulesLine[] }
  | {
      status: 'needs_owner_approval'
      proposal_id: string
      proposal_version: number
      strictness: Strictness | 'not_comparable'
      summary_diff: ApprovalRulesDiff[]
      summary: ApprovalRulesLine[]
    }

/** A partner alert as recorded in {@link PartnerSettings.recent_alerts} (CLE-218). */
export interface PartnerAlertRecord {
  kind: 'webhook_subscription_deactivated' | 'outbound_credential_disabled' | 'dispatch_gave_up' | (string & {})
  org_id: string
  external_id: string | null
  occurred_at: string
  /** Where it went: 'email' and/or 'webhook'. Empty = no destination configured, or delivery failed. */
  delivered_to: string[]
  detail: Record<string, unknown>
}

/** Your account-wide partner settings (GET /v1/partner/settings, CLE-212 / CLE-218). */
export interface PartnerSettings {
  partner_id: string
  retention_days: number | null
  /** Where `cleared` items are dispatched when neither the request nor the policy names a destination. */
  execution_url: string | null
  /** The same for rejected / expired / sent_back. */
  notify_url: string | null
  /** Operational alerts for your orgs (instead of the orgs' owners). */
  alert_email: string | null
  alert_webhook_url: string | null
  /** true when alert_webhook_url is set with a signing secret. The secret itself is never returned by getSettings. */
  alert_webhook_configured: boolean
  recent_alerts: PartnerAlertRecord[]
  /** CLE-219: design tokens for the embedded approval UI (@clearedby/react). */
  theme?: ClearedByTheme | null
}

/**
 * CLE-219: design tokens for the embedded approval UI (the same shape as
 * `ClearedByTheme` in @clearedby/react). Values must be plain CSS colours,
 * lengths, font lists or shadows — anything else is refused with 400.
 */
export interface ClearedByThemeColors {
  primary?: string
  primaryText?: string
  surface?: string
  surfaceAlt?: string
  border?: string
  text?: string
  mutedText?: string
  success?: string
  warning?: string
  danger?: string
}
export interface ClearedByTheme {
  colors?: ClearedByThemeColors
  radius?: string
  fontFamily?: string
  fontSize?: string
  spacing?: { xs?: string; sm?: string; md?: string; lg?: string }
  shadow?: string
  dark?: { colors?: ClearedByThemeColors; shadow?: string }
}

/**
 * PATCH /v1/partner/settings. Every field optional; `null` clears one. URLs must
 * be public https (checked against ClearedBy's SSRF guard, DNS included).
 */
export interface UpdatePartnerSettingsInput {
  retention_days?: number | null
  execution_url?: string | null
  notify_url?: string | null
  alert_email?: string | null
  alert_webhook_url?: string | null
  /** Mint a new alert webhook signing secret (returned once, as `alert_webhook_secret`). */
  rotate_alert_webhook_secret?: true
  /** CLE-219: the account-wide theme (replaces the stored one; null clears it). Per-org: PATCH /v1/partner/orgs/:id {theme}. */
  theme?: ClearedByTheme | null
}

// ---- Partner orgs, keys, reviewers, erasure (CLE-206 / CLE-212) ----

/** One of your merchant orgs (GET /v1/partner/orgs/:id). */
export interface PartnerOrg {
  org_id: string
  /** Your id for the merchant (unique per partner). */
  external_id: string
  name: string
  /** Legacy single domain (the first of shop_domains when unset). */
  shop_domain: string | null
  /** CLE-217: the *.myshopify.com stores this org's keys may act on. */
  shop_domains: string[]
  /** CLE-215: ISO 4217 base currency, or null when unset (GBP is then assumed). */
  currency: string | null
  /** CLE-218: this org's override of your execution_url (null = your default applies). */
  execution_url: string | null
  /** CLE-218: this org's override of your notify_url (null = your default applies). */
  notify_url: string | null
  /** CLE-219: this org's theme override (null = your account theme applies as is). */
  theme: ClearedByTheme | null
  plan: string
  created_at: string
}

/** POST /v1/partner/orgs. Idempotent on `external_id`. */
export interface CreateOrgInput {
  /** Your id for the merchant: 1–200 chars of letters, digits and . _ : @ | + = - */
  external_id: string
  name: string
  /** ISO 4217, e.g. 'GBP'. What reviewer authority caps and amount limits are in. */
  currency?: string
  /** CLE-217: the merchant's permanent *.myshopify.com domains (max 50). */
  shop_domains?: string[]
  /** Legacy single hostname; prefer `shop_domains`. */
  shop_domain?: string
}

export interface CreateOrgResult extends PartnerOrg {
  /** true on first creation (201); false when the org already existed (200). */
  created: boolean
  /** The org's first `cb_live_` requester key, ONLY on first creation. Store it. */
  api_key?: string
}

/** PATCH /v1/partner/orgs/:id: at least one field. `null` clears an override. */
export interface UpdateOrgInput {
  name?: string
  currency?: string
  /** REPLACES the allowed-store list. */
  shop_domains?: string[]
  execution_url?: string | null
  notify_url?: string | null
  /** REPLACES the org's theme override; null clears it. */
  theme?: ClearedByTheme | null
}

export interface ListOrgsOptions {
  /** 1–500, default 100. */
  limit?: number
  /** Cursor: the `next_after` of the previous page. */
  after?: string
  /** Only the org with this external_id. */
  externalId?: string
}

/** A newly minted org key (POST /v1/partner/orgs/:id/keys). `api_key` is shown once. */
export interface OrgKey {
  org_id: string
  key_id: string
  api_key: string
  prefix: string
  name: string
}

/** One of an org's keys, as `listOrgKeys` / `revokeOrgKey` return it (CLE-224). Never the secret. */
export interface OrgKeyInfo {
  key_id: string
  name: string
  prefix: string
  /** The agent the key is bound to (a verified doer), or null. */
  agent_id: string | null
  created_at: string
  last_used_at: string | null
  /** When the key stopped working (revoked, or its rotation grace ran out). Null while active. */
  revoked_at: string | null
  /** When a rotated-out key stops working, while its grace period is still running. */
  revokes_at: string | null
  /** `partner:<id>` or `user:<id>` once revoked or scheduled. */
  revoked_by: string | null
  active: boolean
}

/** `rotateOrgKey` (CLE-224): the replacement key (secret shown once) and the key it replaced. */
export interface RotatedOrgKey extends OrgKey {
  agent_id: string | null
  replaced: OrgKeyInfo
}

export type ReviewerRole = 'owner' | 'admin' | 'reviewer'

/** PUT /v1/partner/orgs/:id/reviewers/:external_subject. Replaces the whole reviewer. */
export interface ReviewerInput {
  display_name: string
  /** Optional; without one, nothing is ever emailed to this person. */
  email?: string
  role: ReviewerRole
  /**
   * `{ action pattern or '*': max amount in MINOR units of the org currency }`,
   * e.g. `{ 'shopify.refund.create': 50000 }` = up to 500.00. Replaces the map.
   */
  authority: Record<string, number>
  channels?: string[]
}

export interface PartnerReviewer {
  external_subject: string
  user_id: string
  display_name: string
  email: string | null
  role: ReviewerRole | (string & {})
  authority: Record<string, number>
  channels: string[]
  /** false once removed (history is kept). */
  active: boolean
}

/** POST /v1/partner/orgs/:id/erasure. */
export interface OrgErasureResult {
  org_id: string
  external_id: string
  items_redacted: number
  /** The org's `redaction` attestation for this request. */
  attestation_seq: number
}

/** POST /v1/partner/erasure: one subject across every org you own. */
export interface PartnerErasureResult {
  subject_hash: string
  orgs_scanned: number
  items_redacted: number
  /** Orgs that held the subject's data (each got a `redaction` attestation). */
  orgs: OrgErasureResult[]
  /** Orgs where erasure failed. Call again (it is idempotent). */
  failed: { org_id: string; external_id: string }[]
  complete: boolean
}

/** POST /v1/policies/:name/:version/activate. */
export interface PolicyActivation {
  activated: { name: string; version: number }
  attestation: { seq: number; hash: string }
  /** When accepting approval rules also lined up two-person approval with the current approvers. */
  rules_synced?: { name: string; version: number }
}

/** Read-method options on ClearedByPartner: read with the partner key, or AS a reviewer with their token. */
export interface PartnerReadAuth {
  /**
   * A reviewer token from createDecisionToken / createReadToken. Reads are
   * then done as that person (list defaults to their queue). Omit to read
   * with the partner key.
   */
  token?: string
}

/**
 * The partner client. Server-side only: it holds your `cb_partner_` key.
 * Every org-scoped method takes the org id first.
 */
export class ClearedByPartner {
  private readonly t: Transport

  constructor(opts: ClearedByPartnerOptions) {
    if (!opts?.partnerKey) throw new Error('ClearedByPartner: partnerKey is required')
    this.t = new Transport(opts.partnerKey, opts.baseUrl, opts.fetch, 'ClearedByPartner')
  }

  // ---- Orgs ----

  /**
   * Provision a merchant org (POST /v1/partner/orgs). Idempotent on
   * `external_id`: the first call returns `created: true` and a one-time
   * `api_key`; repeats return the existing org with no key. The org starts
   * with the default approval rules.
   */
  async createOrg(input: CreateOrgInput): Promise<CreateOrgResult> {
    return this.t.request<CreateOrgResult>('POST', '/v1/partner/orgs', { body: input, ok: [200, 201], what: 'create org' })
  }

  /** One of your orgs. Any other id is a 404. */
  async getOrg(orgId: string): Promise<PartnerOrg> {
    return this.t.request<PartnerOrg>('GET', `/v1/partner/orgs/${seg(orgId)}`, { what: 'get org' })
  }

  /** Your orgs, oldest first. Page with `after: page.next_after`; filter with `externalId`. */
  async listOrgs(opts: ListOrgsOptions = {}): Promise<{ orgs: PartnerOrg[]; next_after: string | null }> {
    return this.t.request('GET', '/v1/partner/orgs', {
      query: { limit: opts.limit, after: opts.after, external_id: opts.externalId },
      what: 'list orgs',
    })
  }

  /** Every org, page by page: `for await (const org of partner.iterateOrgs()) …` */
  async *iterateOrgs(opts: { pageSize?: number } = {}): AsyncGenerator<PartnerOrg, void, undefined> {
    let after: string | undefined
    for (;;) {
      const page = await this.listOrgs({ limit: opts.pageSize ?? 100, ...(after === undefined ? {} : { after }) })
      for (const org of page.orgs) yield org
      if (page.next_after === null) return
      after = page.next_after
    }
  }

  /** The org with this external_id, or null. */
  async findOrg(externalId: string): Promise<PartnerOrg | null> {
    const page = await this.listOrgs({ externalId, limit: 1 })
    return page.orgs[0] ?? null
  }

  /**
   * Change an org (PATCH /v1/partner/orgs/:id): name, currency, shop_domains
   * (replaces the list), execution_url / notify_url overrides and theme. `null`
   * clears an override back to your account default.
   */
  async updateOrg(orgId: string, input: UpdateOrgInput): Promise<PartnerOrg> {
    return this.t.request<PartnerOrg>('PATCH', `/v1/partner/orgs/${seg(orgId)}`, { body: input, what: 'update org' })
  }

  /** The effective embedded-UI theme: your account theme with the org's override on top (null = package defaults). */
  async getOrgTheme(orgId: string): Promise<ClearedByTheme | null> {
    const json = await this.t.request<{ theme: ClearedByTheme | null }>('GET', `/v1/partner/orgs/${seg(orgId)}/theme`, { what: 'get org theme' })
    return json.theme
  }

  /**
   * Mint another `cb_live_` requester key for the org (POST
   * /v1/partner/orgs/:id/keys), e.g. a separate executor key. `api_key` is
   * returned once. Use it with `new ClearedBy({ apiKey })`.
   */
  async createOrgKey(orgId: string, opts: { name?: string } = {}): Promise<OrgKey> {
    return this.t.request<OrgKey>('POST', `/v1/partner/orgs/${seg(orgId)}/keys`, {
      body: opts.name === undefined ? {} : { name: opts.name },
      ok: [201],
      what: 'create org key',
    })
  }

  /**
   * CLE-224: every `cb_live_` key the org has had, newest first, revoked ones
   * included (GET /v1/partner/orgs/:id/keys). Never the secrets.
   */
  async listOrgKeys(orgId: string): Promise<OrgKeyInfo[]> {
    const json = await this.t.request<{ keys: OrgKeyInfo[] }>('GET', `/v1/partner/orgs/${seg(orgId)}/keys`, {
      what: 'list org keys',
    })
    return json.keys
  }

  /**
   * CLE-224: revoke one org key (DELETE /v1/partner/orgs/:id/keys/:keyId). Its
   * next request gets `401`. Idempotent; 404 for a key that isn't the org's.
   */
  async revokeOrgKey(orgId: string, keyId: string): Promise<OrgKeyInfo & { org_id: string }> {
    return this.t.request('DELETE', `/v1/partner/orgs/${seg(orgId)}/keys/${seg(keyId)}`, { what: 'revoke org key' })
  }

  /**
   * CLE-224: replace a key (POST /v1/partner/orgs/:id/keys/:keyId/rotate). The
   * new key has the same name and agent binding; `api_key` is returned once. The
   * old key is revoked at once, or after `graceSeconds` (max 86400) so you can
   * roll the new one out first. `409 key_revoked` if it was already revoked or
   * rotated.
   */
  async rotateOrgKey(orgId: string, keyId: string, opts: { graceSeconds?: number } = {}): Promise<RotatedOrgKey> {
    return this.t.request<RotatedOrgKey>('POST', `/v1/partner/orgs/${seg(orgId)}/keys/${seg(keyId)}/rotate`, {
      body: opts.graceSeconds === undefined ? {} : { grace_seconds: opts.graceSeconds },
      ok: [201],
      what: 'rotate org key',
    })
  }

  // ---- Webhooks ----

  /**
   * CLE-224: subscribe one of your orgs to lifecycle events (POST
   * /v1/webhooks?org_id=) with the partner key. `secret` is returned once.
   */
  async createWebhook(orgId: string, input: CreateWebhookInput): Promise<Webhook & { secret: string }> {
    return this.t.request('POST', '/v1/webhooks', { query: { org_id: orgId }, body: input, ok: [201], what: 'create webhook' })
  }

  /** CLE-224: the org's subscriptions, newest first (GET /v1/webhooks?org_id=). Secrets are never returned. */
  async listWebhooks(orgId: string): Promise<Webhook[]> {
    const json = await this.t.request<{ webhooks: Webhook[] }>('GET', '/v1/webhooks', { query: { org_id: orgId }, what: 'list webhooks' })
    return json.webhooks
  }

  /** CLE-224: unsubscribe (DELETE /v1/webhooks/:id?org_id=). 404 for an id that isn't that org's. */
  async deleteWebhook(orgId: string, id: string): Promise<{ deleted: true; id: string }> {
    return this.t.request('DELETE', `/v1/webhooks/${seg(id)}`, { query: { org_id: orgId }, what: 'delete webhook' })
  }

  // ---- Reviewers ----

  /**
   * Create or replace a reviewer (PUT /v1/partner/orgs/:id/reviewers/:subject):
   * the person (no ClearedBy login) and their authority. Authority changes go
   * on the org's chain. `created` is true on first creation.
   */
  async upsertReviewer(orgId: string, externalSubject: string, input: ReviewerInput): Promise<PartnerReviewer & { created: boolean }> {
    const { status, json } = await this.t.raw('PUT', `/v1/partner/orgs/${seg(orgId)}/reviewers/${seg(externalSubject)}`, { body: input })
    if (status !== 200 && status !== 201) throw apiError(status, json, 'upsert reviewer')
    return { ...(json as PartnerReviewer), created: status === 201 }
  }

  /** Remove a reviewer: authority and routing go (attested), history stays. Idempotent. */
  async removeReviewer(orgId: string, externalSubject: string): Promise<PartnerReviewer> {
    return this.t.request<PartnerReviewer>('DELETE', `/v1/partner/orgs/${seg(orgId)}/reviewers/${seg(externalSubject)}`, { what: 'remove reviewer' })
  }

  /** The org's partner-provisioned people, removed ones included (`active: false`). */
  async listReviewers(orgId: string): Promise<PartnerReviewer[]> {
    const json = await this.t.request<{ reviewers: PartnerReviewer[] }>('GET', `/v1/partner/orgs/${seg(orgId)}/reviewers`, { what: 'list reviewers' })
    return json.reviewers
  }

  // ---- Decision & read tokens ----

  /**
   * Exchange the partner key for a decision token naming one reviewer
   * (`externalSubject` = your id for them). Valid ≤ 300s, single-use; pass
   * `workItemId` to pin it to one held item.
   */
  async createDecisionToken(input: {
    orgId: string
    externalSubject: string
    workItemId?: string
    ttlSeconds?: number
    /**
     * CLE-219: 'read' mints a reusable read-only token (≤ 900s, default 600)
     * for the read endpoints — list / get / permissions / events as this
     * reviewer. It can never decide. Default 'decide'.
     */
    scope?: 'decide' | 'read'
  }): Promise<DecisionToken> {
    return this.t.request<DecisionToken>('POST', '/v1/auth/decision-token', {
      body: {
        org_id: input.orgId,
        external_subject: input.externalSubject,
        ...(input.workItemId ? { work_item_id: input.workItemId } : {}),
        ...(input.ttlSeconds !== undefined ? { ttl_seconds: input.ttlSeconds } : {}),
        ...(input.scope !== undefined ? { scope: input.scope } : {}),
      },
      ok: [201],
      what: 'decision token',
    })
  }

  /** createDecisionToken with `scope: 'read'`: a reusable read-only token for one reviewer (≤ 900s). */
  async createReadToken(input: { orgId: string; externalSubject: string; workItemId?: string; ttlSeconds?: number }): Promise<DecisionToken> {
    return this.createDecisionToken({ ...input, scope: 'read' })
  }

  /**
   * Record a reviewer's decision with their decision token. `reason` is required
   * (≥ 4 chars) for reject and send_back. `escalateTo` is the external_subject
   * of the reviewer to hand the item to; it must be an active reviewer whose
   * authority covers the item, else the call fails with 422
   * `escalate_target_not_found` / `escalate_target_lacks_authority`.
   */
  async decide(
    id: string,
    input: { decision: PartnerDecision; reason?: string; escalateTo?: string },
    auth: { token: string },
  ): Promise<PartnerDecideResult> {
    return this.t.request<PartnerDecideResult>('POST', `/v1/gate/${seg(id)}/decide`, {
      bearer: auth.token,
      body: {
        decision: input.decision,
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
        ...(input.escalateTo ? { escalate_to: input.escalateTo } : {}),
      },
      what: 'decide',
    })
  }

  // ---- Items ----

  /**
   * CLE-204: attach facts your backend looked up itself (e.g. the Shopify order
   * behind a refund the agent proposed) to a held item (pending or escalated)
   * as `partner_verified` evidence. Their hashes go on the signed chain. The
   * item is NOT re-evaluated — it is already waiting for a human, who sees the
   * facts badged "Verified by <your name>". Only a partner key can do this.
   */
  async attachEvidence(orgId: string, itemId: string, items: AttachEvidenceItem[]): Promise<AttachEvidenceResult> {
    return this.t.request<AttachEvidenceResult>('POST', `/v1/gate/${seg(itemId)}/evidence`, {
      query: { org_id: orgId },
      body: { items },
      ok: [201],
      what: 'attach evidence',
    })
  }

  /**
   * CLE-201: revoke an approved action in one of your orgs before it runs.
   * With no `auth` the partner key does it (allowed for any org you own). Pass
   * `{ token }` (a decision token from createDecisionToken) to revoke AS a
   * named reviewer: owners/admins, or a reviewer whose authority covers the
   * action. `reason` (4+ characters) is required.
   */
  async revoke(orgId: string, id: string, reason: string, auth?: { token: string }): Promise<RevokeResult> {
    return this.t.request<RevokeResult>('POST', `/v1/gate/${seg(id)}/revoke`, {
      ...(auth === undefined ? { query: { org_id: orgId } } : { bearer: auth.token }),
      body: { reason },
      what: 'revoke',
    })
  }

  /** CLE-201: withdraw a still-open (pending / escalated) request in one of your orgs. */
  async withdraw(orgId: string, id: string, reason?: string): Promise<WithdrawResult> {
    return this.t.request<WithdrawResult>('POST', `/v1/gate/${seg(id)}/withdraw`, {
      query: { org_id: orgId },
      body: reason === undefined ? {} : { reason },
      what: 'withdraw',
    })
  }

  /** Clearances in one of your orgs, newest first (GET /v1/gate?org_id=). */
  async list(orgId: string, opts: Omit<ListOptions, 'orgId'> & PartnerReadAuth = {}): Promise<{ items: Clearance[]; next_cursor: string | null }> {
    const { token, ...rest } = opts
    return this.t.request('GET', '/v1/gate', { query: listQuery({ ...rest, orgId }), bearer: token, what: 'list' })
  }

  /** Full detail for one item (GET /v1/gate/:id/detail?org_id=). */
  async get(orgId: string, id: string, opts: { include?: IncludeOption[] } & PartnerReadAuth = {}): Promise<Clearance> {
    return this.t.request<Clearance>('GET', `/v1/gate/${seg(id)}/detail`, {
      query: { include: includeQ(opts.include), org_id: orgId },
      bearer: opts.token,
      what: 'get',
    })
  }

  /** The item's lightweight status shape (GET /v1/gate/:id?org_id=). */
  async status(orgId: string, id: string, opts: PartnerReadAuth = {}): Promise<GateResult> {
    return this.t.request<GateResult>('GET', `/v1/gate/${seg(id)}`, { query: { org_id: orgId }, bearer: opts.token, what: 'status' })
  }

  /** The item's audit timeline, oldest first. `lineage: true` merges the revise chain. */
  async events(orgId: string, id: string, opts: { lineage?: boolean } & PartnerReadAuth = {}): Promise<ClearanceEvent[]> {
    const json = await this.t.request<{ events: ClearanceEvent[] }>('GET', `/v1/gate/${seg(id)}/events`, {
      query: { include: opts.lineage ? 'lineage' : undefined, org_id: orgId },
      bearer: opts.token,
      what: 'events',
    })
    return json.events
  }

  /** What `reviewer` (external_subject) may decide on this item right now, and why not the rest. */
  async permissions(orgId: string, id: string, reviewer: string, opts: PartnerReadAuth = {}): Promise<Permissions> {
    return this.t.request<Permissions>('GET', `/v1/gate/${seg(id)}/permissions`, {
      query: { reviewer, org_id: orgId },
      bearer: opts.token,
      what: 'permissions',
    })
  }

  // ---- Approval rules & policies ----

  /** The merchant's approval rules: knobs, plain-English lines, and any proposal awaiting the owner. */
  async getRules(orgId: string): Promise<ApprovalRules> {
    return this.t.request<ApprovalRules>('GET', `/v1/partner/orgs/${seg(orgId)}/rules`, { what: 'get rules' })
  }

  /**
   * Change any subset of knobs. Stricter or equal → `{status: 'active'}`.
   * Looser → `{status: 'needs_owner_approval', proposal_id, summary_diff}`:
   * show the diff to an owner/admin and call acceptRules with their token.
   */
  async setRules(orgId: string, settings: Partial<ApprovalRulesSettings>): Promise<SetRulesResult> {
    return this.t.request<SetRulesResult>('PUT', `/v1/partner/orgs/${seg(orgId)}/rules`, {
      body: { settings },
      ok: [200, 202],
      what: 'set rules',
    })
  }

  /** Accept a looser proposal with an owner/admin decision token (from createDecisionToken). */
  async acceptRules(
    orgId: string,
    proposalId: string,
    auth: { token: string },
  ): Promise<{ status: 'active'; active_version: number; attestation: { seq: number; hash: string }; summary: ApprovalRulesLine[] }> {
    return this.t.request('POST', `/v1/partner/orgs/${seg(orgId)}/rules/${seg(proposalId)}/accept`, {
      bearer: auth.token,
      what: 'accept rules',
    })
  }

  /**
   * Activate a stored policy version in one of your orgs (POST
   * /v1/policies/:name/:version/activate). With the partner key it is allowed
   * only when the version is not looser than the active one (else 403
   * `owner_approval_required`); pass `{ token }` (an owner/admin decision
   * token) to activate as the merchant.
   */
  async activatePolicy(orgId: string, name: string, version: number, auth?: { token: string }): Promise<PolicyActivation> {
    return this.t.request<PolicyActivation>('POST', `/v1/policies/${seg(name)}/${seg(version)}/activate`, {
      ...(auth === undefined ? { body: { org_id: orgId } } : { bearer: auth.token }),
      what: 'activate policy',
    })
  }

  // ---- Settings & secrets ----

  /**
   * CLE-218: your account-wide settings: retention, the execution_url /
   * notify_url every org's decisions are dispatched to by default, and where
   * operational alerts go. Never includes the alert webhook secret.
   */
  async getSettings(): Promise<PartnerSettings> {
    return this.t.request<PartnerSettings>('GET', '/v1/partner/settings', { what: 'get settings' })
  }

  /**
   * CLE-218: change any subset of your settings. The first time you set
   * `alert_webhook_url` (or pass `rotate_alert_webhook_secret: true`) the
   * response carries `alert_webhook_secret` ONCE: store it to verify alert
   * POSTs (`x-clearedby-signature: sha256=<hex HMAC-SHA256(secret, raw body)>`).
   */
  async updateSettings(input: UpdatePartnerSettingsInput): Promise<PartnerSettings & { alert_webhook_secret?: string }> {
    return this.t.request('PATCH', '/v1/partner/settings', { body: input, what: 'update settings' })
  }

  /**
   * CLE-218: the org's signing secret (GET /v1/signing-secrets?org_id=): what
   * your execution_url / notify_url receiver passes to `verifyDispatch` as
   * `secret`. Stable per org. `getSigningSecrets` returns the full view.
   */
  async getSigningSecret(orgId: string): Promise<string> {
    return (await this.getSigningSecrets(orgId)).on_decision.secret
  }

  /** The org's full signing-secret view (on_decision + callback secrets and their header formats). */
  async getSigningSecrets(orgId: string): Promise<SigningSecrets> {
    return this.t.request<SigningSecrets>('GET', '/v1/signing-secrets', { query: { org_id: orgId }, what: 'get signing secret' })
  }

  // ---- Data protection ----

  /**
   * Erase one data subject's readable data in one org (POST
   * /v1/partner/orgs/:id/erasure, CLE-212). `subjectId` is the
   * `context.subject_id` you gated with (e.g. a Shopify customer GID). It goes
   * in the body, never the URL. Safe to retry (a repeat reports 0 redacted).
   */
  async eraseSubject(orgId: string, subjectId: string): Promise<OrgErasureResult> {
    return this.t.request<OrgErasureResult>('POST', `/v1/partner/orgs/${seg(orgId)}/erasure`, {
      body: { subject_id: subjectId },
      what: 'erase subject',
    })
  }

  /**
   * Erase one data subject across EVERY org you own (POST /v1/partner/erasure).
   * Orgs holding nothing for them are skipped. `complete: false` lists orgs
   * that failed: call again (idempotent).
   */
  async eraseSubjectEverywhere(subjectId: string): Promise<PartnerErasureResult> {
    return this.t.request<PartnerErasureResult>('POST', '/v1/partner/erasure', {
      body: { subject_id: subjectId },
      what: 'erase subject everywhere',
    })
  }
}


export default ClearedBy
