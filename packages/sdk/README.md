# @clearedby/sdk

A tiny, dependency-free client for the [ClearedBy](https://clearedby.com) gate. Call `gate()` before a consequential agent action — policy clears it instantly, rejects it, or holds it for a human. `wait()` blocks until a held item resolves; `guard()` wraps a function so it only runs once cleared.

Works anywhere `fetch` exists (Node 18+, edge, browser).

## Install

```bash
npm i @clearedby/sdk
```

## Quick start

```ts
import { ClearedBy, RejectedError } from '@clearedby/sdk'

const cb = new ClearedBy({ apiKey: process.env.CLEAREDBY_API_KEY! })

// Only issue the refund if the gate clears it (now or after a human approves).
try {
  await cb.guard(
    { action: 'refund.create', params: { amount: 250, order: 'SO-441', currency: 'GBP' } },
    async () => {
      await shopify.refund('SO-441', 250)
    },
  )
} catch (err) {
  if (err instanceof RejectedError) {
    // a policy rule or a reviewer said no
    console.log('refund blocked:', err.result.reason)
  } else throw err
}
```

## Blocking, fire-and-forget, or poll

When an action is held for a human, you choose how to handle the wait:

**Block** — simplest; best for short, in-session decisions. `guard()` (above) or `gate()` + `wait()`:

```ts
const r = await cb.gate(input)
const final = await cb.wait(r.id) // resolves when a human decides (or times out)
```

**Fire-and-forget** — submit and return immediately; ClearedBy POSTs the verdict to your URL when a human decides. Best for long / out-of-hours reviews, so you never hold a request open:

```ts
const r = await cb.gate({ ...input, callbackUrl: 'https://your-app.com/hooks/clearedby' })
// r.status is 'pending' — return now. Later, ClearedBy POSTs to your hook (with retries):
//   { id, status: 'cleared' | 'rejected' | 'sent_back', reason, attestation: { seq, hash } }
// Branch on status to act — your endpoint is where the work happens.
```

Verify the callback is genuinely from ClearedBy: the gate response's `r.resume.signing_secret` is the HMAC key, and each POST carries `X-ClearedBy-Signature: sha256=hmac(secret, rawBody)` — recompute it over the raw request body and compare.

**Poll** — `gate(input)`, then call `status(id)` whenever you like.

## The send-back (revise) loop

A reviewer can return an action to *revise* instead of approving or rejecting it. `guard()` throws `SentBackError` (and `wait()`/`status()` report `status: 'sent_back'`). Catch it, regenerate, and `resubmit()` against the same lineage:

```ts
import { SentBackError } from '@clearedby/sdk'

let input = { action: 'refund.create', params: { amount: 250, order: 'SO-441' } }
for (;;) {
  try {
    await cb.guard(input, () => shopify.refund('SO-441', input.params.amount))
    break
  } catch (e) {
    if (e instanceof SentBackError) {
      input = revise(input, e.result.reason)      // your regeneration, using the reviewer's note
      input.parentItemId = e.result.id            // keep the whole revise chain on one lineage
      continue
    }
    throw e
  }
}
```

## Proof cases & evidence

A gate call isn't just "may I do this" — the agent submits the **case** for it, and the reviewer judges that case. Add an optional `proof` to any `gate()` / `resubmit()`:

```ts
await cb.gate({
  action: 'refund.create',
  params: { amount: 420, order: 'SO-118', currency: 'GBP' },
  proof: {
    reason: 'Customer reports the item arrived damaged; delivery confirmed.',
    confidence: 0.9,
    recommended_outcome: 'approve_refund',
    risk_flags: ['full_order_value'],
    evidence: [
      { type: 'threshold', value: { label: 'Refund vs order total', value: 420, limit: 400, unit: '£' } },
      { type: 'entity', value: { name: 'a.popov@example.com', subtitle: 'Order SO-118',
          fields: [{ label: 'Orders', value: 14 }, { label: 'Prior refunds', value: 1 }],
          badges: [{ label: 'damaged item', tone: 'warn' }] } },
      { type: 'timeline', value: [{ label: 'Delivered', at: 'Jun 9' }, { label: 'Damage reported', at: 'Jun 10' }] },
      { type: 'source', value: { title: 'Support ticket #4821', snippet: '…arrived cracked…', url: 'https://…' } },
      { type: 'conversation', value: { title: 'Support thread #4821', messages: [
          { from: 'customer', text: 'The lamp arrived cracked.', at: 'Jun 10' },
          { from: 'agent', text: 'So sorry — could you send a photo?', at: 'Jun 10' },
          { from: 'customer', text: 'Here it is:', image: 'https://…/damage.jpg', at: 'Jun 10' } ] } },
    ],
  },
})
```

The reviewer sees a **Proof Case** panel — recommended outcome, confidence, reason, risk flags, and a **friendly card per evidence item**. Recognised `type`s (`threshold`, `entity`, `timeline`, `table`, `media`, `source`, `conversation`) render as cards — `conversation` is a chat/support thread shown as a message-bubble transcript; **any other `type` falls back to a generic key/value card**, so you can always invent your own. Set an optional `width: 'half' | 'full'` on any card to control layout — compact cards (`threshold`, `entity`) pair side-by-side by default. The typed shapes (`ThresholdEvidence`, `EntityEvidence`, …) are exported — annotate a `value` (or use `satisfies Evidence`) to get them checked. **Every card type and field is catalogued in [EVIDENCE.md](https://github.com/ClearedBy/clearedby-js/blob/main/EVIDENCE.md).**

ClearedBy **presents** your case to a human and pins it, tamper-evident, to their decision — it does **not** verify the *truth* of evidence. The cards are your assertions; the reviewer rules on them. Every item in `proof` is stored with provenance `agent_claim` and badged "Agent says". A `verified: true` you write on a card is ignored (`SourceEvidence.verified` is deprecated). Verified evidence comes only from a partner's backend (`ClearedByPartner.attachEvidence`) or from ClearedBy itself, and a policy rule can require it with `requires_verified: [type]`. `proof` is optional and fully backward-compatible.

## Authorization Receipts — verify, don't trust

Every enforce-mode **cleared** verdict comes with a **portable signed receipt**: a
self-contained JSON statement of exactly what was authorized — which agent, for
which org, which action, the exact params, who approved it, who it's *for*
(`audience`), and until when. A third party verifies it **offline** against
ClearedBy's published keys (`https://app.clearedby.com/.well-known/clearedby-keys`)
— no ClearedBy API call, no account, no trust in our database. If anything was
altered — the amount, the target, the expiry — the signature breaks.

Requesting side — name the relying party when you gate:

```ts
const r = await clearedby.gate({
  action: 'refund.create',
  params: { amount: 250, currency: 'GBP', order: 'SO-441' },
  audience: 'mcp://billing.example.com', // who will accept this authorization
})
// r.receipt — hand this to the relying party (expires ~10 min after issue)
```

Relying-party side (Node 18+ — the verifier lives on its own subpath so the
main entry stays browser-safe):

```ts
import { verifyReceipt, fetchClearedByKeys } from '@clearedby/sdk/receipt'

const keys = await fetchClearedByKeys() // cache; refetch on 'unknown_key'
const v = verifyReceipt(receipt, {
  keys,
  audience: 'mcp://billing.example.com', // YOUR identity — always pass it
  action: 'refund.create',
})
if (!v.valid) throw new Error(`unauthorized: ${v.reason}`)
// v.receipt.params are now trustworthy — enforce your own ceilings against them
execute(v.receipt.params)
```

`verifyReceipt` checks signature, freshness (30s clock skew), audience and
action binding, and returns stable reasons (`bad_signature`, `expired`,
`audience_mismatch`, …). A verifier that passes `audience` rejects receipts
naming anyone else **and** receipts naming nobody. Two things stay yours:
track seen `nonce`s for ~the TTL (replay), and enforce constraints beyond
`action` equality (e.g. `params.amount` ceilings). The receipt's
`context_hash` attests what ClearedBy *evaluated* — not that the evidence is
true. Re-fetch a receipt any time via `GET /v1/gate/:id/receipt`.

## Receiving on_decision dispatches

If ClearedBy POSTs decisions to your execution endpoint (`on_decision`),
verify each one before acting:

```ts
import { verifyDispatch } from '@clearedby/sdk/dispatch'

const { envelope, params } = await verifyDispatch(rawBody, req.headers, {
  secret: process.env.CLEAREDBY_SIGNING_SECRET!, // credential odsec_…, or GET /v1/signing-secrets
  jwksUrl: 'https://app.clearedby.com/.well-known/clearedby-keys',
  audience: 'https://exec.you.example',
})
// dedupe on envelope.work_item_id (answer 409 {"status":"already_executed"} on repeats),
// then execute ONLY from `params` — the receipt-signed params.
```

It checks the timestamped `clearedby-signature` (default tolerance 300s), the
v2 envelope, and for cleared verdicts the receipt plus its binding to the
envelope's org, work item, action and params. It throws a
`DispatchVerificationError` with a stable `code`. Every delivery attempt
carries a freshly minted receipt, so dedupe on `work_item_id`, never on the
nonce. Full contract: `docs/dispatch-contract.md`; runnable receiver:
`examples/dispatch-receiver`.

**Is it authentic, or still valid?** All of the above is offline: it proves
the dispatch is authentic. An approval can still be **revoked** before it runs
(CLE-201). For anything irreversible (refunds, payouts), add
`checkStatus: true`: it asks `GET /v1/receipts/:receipt_id/status` (public, no
key) and throws `ReceiptRevokedError` (`code: 'receipt_revoked'`) for a revoked
authorization, or `code: 'status_unavailable'` if it can't ask (fails closed).
Default off. For a bare receipt, `verifyReceiptOnline(receipt, { keys,
checkStatus: true })` from `@clearedby/sdk/receipt` does the same.

## API

Two clients cover the whole HTTP API, so you never need your own `fetch` helper:

- **`ClearedBy`**: the org client, with the org's `cb_live_` key. It proposes, follows, executes and reads for one org.
- **`ClearedByPartner`**: the partner client, with your `cb_partner_` key (server-side only). It provisions and runs many merchant orgs. Every org-scoped method takes the org id first.

Both take `{ baseUrl?, fetch? }`. `baseUrl` defaults to `https://app.clearedby.com`. Every method returns the parsed JSON and throws `ClearedByApiError` on a non-2xx answer (see [Errors](#errors)). Request bodies that mirror an HTTP body (orgs, reviewers, settings, rules, webhooks) use the API's snake_case field names. Option bags use camelCase.

### `new ClearedBy({ apiKey, baseUrl?, fetch? })`

**Propose**

| Method | HTTP | Returns |
| --- | --- | --- |
| `gate(input)` | `POST /v1/gate` | `GateResult`: `cleared` / `rejected` / `pending` (+ `receipt` when cleared, `warnings`) |
| `check(input)` | `POST /v1/gate?dry=1` | `CheckResult`: what the policy would do. Nothing is stored. |
| `resubmit(parentItemId, input)` | `POST /v1/gate` with `parent_item_id` | `GateResult` for the revised attempt |
| `guard(input, fn)` | gate, then wait | `fn`'s result, only once cleared. Throws `RejectedError` / `SentBackError` / `TestItemError`. |

`GateInput`: `{ action, params?, context?, proof?, policy?, audience?, mode?, callbackUrl?, timeout?, onDecision?, reverts?, parentItemId?, idempotencyKey? }`.
`callback_url` and `on_decision` are accepted as aliases of `callbackUrl` / `onDecision`.

- `context` is free-form. ClearedBy reads these keys: `subject_id` (the data subject, needed for erasure; required in partner orgs for shopper-related actions), `batch_id` (groups items; filter with `list({ batchId })`), `requested_by_subject` (partner orgs: who asked, who then can't approve it under two-person approval) and `summary`.
- `onDecision` sends this item's verdict to other URLs: `{ cleared?: { url }, rejected?: { url }, expired?: { url }, sent_back?: { url } }`. Only URLs; credentials stay on the policy.
- `audience` names the relying party the receipt is for. `reverts` marks the call as the undo of an executed item (see `buildUndo`). `timeout` is seconds or a duration like `"1h"`. `idempotencyKey` is sent as `Idempotency-Key`.

**Follow**

| Method | HTTP | Returns |
| --- | --- | --- |
| `status(id, { orgId? })` | `GET /v1/gate/:id` | `GateResult` |
| `wait(id, { timeoutMs?, pollMs? })` | polls `status` | `GateResult` once no longer `pending` / `escalated`; 408 `timeout` error otherwise |
| `revoke(id, reason)` | `POST /v1/gate/:id/revoke` | `RevokeResult`. Gives back an approval before it runs. |
| `withdraw(id, reason?)` | `POST /v1/gate/:id/withdraw` | `WithdrawResult`. Pulls a still-open request. |

**Execute and prove**

| Method | HTTP | Returns |
| --- | --- | --- |
| `complete(id, input)` | `POST /v1/gate/:id/complete` | `CompleteResult`. `input`: `{ status, completionId?, items?, deliveryReceiptId?, executedParams?, externalRef?, evidence?, result? }` |
| `buildUndo(id)` | `GET /v1/gate/:id/undo` | `UndoInput`: `{ action, params, reverts, keys }`, ready for `gate()` |
| `undo(id, extra?)` | `buildUndo` + `gate` | `GateResult` of the undo proposal |
| `delivery(id)` | `GET /v1/gate/:id/delivery` | `DeliveryState`: `{ id, status, delivery, deliveries }` |
| `redeliver(id)` | `POST /v1/gate/:id/redeliver` | `{ id, delivery }` (1 per item per 30s) |
| `receipt(id)` | `GET /v1/gate/:id/receipt` | the stored `AuthorizationReceipt` |
| `receiptStatus(receiptId)` | `GET /v1/receipts/:receipt_id/status` | `ReceiptStatusView` (`valid` / `expired` / `superseded` / `revoked` / `redacted` / `unknown`) |

**Read** (for your own review UI; with a partner key pass `orgId`, or use the same methods on `ClearedByPartner`)

| Method | HTTP | Returns |
| --- | --- | --- |
| `list({ status?, reviewer?, reviewerUserId?, actionPrefix?, batchId?, cursor?, limit?, include?, orgId? })` | `GET /v1/gate` | `{ items: Clearance[], next_cursor }`, newest first |
| `get(id, { include?, orgId? })` | `GET /v1/gate/:id/detail` | `Clearance`: params, proof, `evidence: { claims, verified }`, routing, escalation, lineage |
| `events(id, { lineage?, orgId? })` | `GET /v1/gate/:id/events` | `ClearanceEvent[]`, oldest first |
| `permissions(id, reviewer, { orgId? })` | `GET /v1/gate/:id/permissions` | `Permissions`: `can`, and `cannot` with reasons |

**Ledger, catalogue, policies**

| Method | HTTP | Returns |
| --- | --- | --- |
| `ledger({ limit?, cursor? })` | `GET /v1/ledger` | `LedgerPage`: `{ rows, next_cursor }` |
| `verifyLedger()` | `GET /v1/ledger/verify` | `{ intact: true, through, rows }` or `{ intact: false, broken_at, reason, rows }` |
| `catalogue()` | `GET /v1/catalogue` | `{ shopify: ActionCatalogue }` |
| `listPolicies()` | `GET /v1/policies` | `PolicyListEntry[]` (names and versions, never rules) |
| `describePolicy(name)` | `GET /v1/policies/:name` | `PolicyShape`: actions, field names, currency |
| `getPolicy(name, version)` | `GET /v1/policies/:name/:version` | `PolicyVersion` (YAML included) |
| `savePolicyDraft(name, yaml)` | `POST /v1/policies/:name` | `SavePolicyDraftResult`. `saved: false` + `lint` / `compile_errors` when blocked (not thrown). |
| `simulatePolicy(name, version, { days? })` | `POST /v1/policies/:name/:version/simulate` | `SimulateResult`: what would have loosened / tightened |

A key can't activate a policy: that is a person's decision (dashboard), or for partner orgs `ClearedByPartner.activatePolicy`.

**Webhooks, secrets, reporting** (org key only)

| Method | HTTP | Returns |
| --- | --- | --- |
| `createWebhook({ url, events, filters?, source? })` | `POST /v1/webhooks` | `Webhook & { secret }`. The secret is shown once. |
| `listWebhooks()` | `GET /v1/webhooks` | `Webhook[]` |
| `deleteWebhook(id)` | `DELETE /v1/webhooks/:id` | `{ deleted: true, id }` |
| `signingSecrets({ orgId? })` | `GET /v1/signing-secrets` | `SigningSecrets`: `on_decision.secret` (for `verifyDispatch`) and `callback.secret` |
| `stats({ days? })` | `GET /v1/stats` | `OrgStats` |
| `usage()` | `GET /v1/usage` | `Usage` for the billing period |
| `graduations({ status? })` | `GET /v1/graduation` | `GraduationProposal[]` |

Dashboard test items (`/v1/test-item`), ratifying graduations and activating policies need a signed-in person, so no key can call them.

### `new ClearedByPartner({ partnerKey, baseUrl?, fetch? })`

For platforms that embed ClearedBy. Server-side only. See `docs/partner-api.md` for the full flow.

**Orgs and keys**

| Method | HTTP | Returns |
| --- | --- | --- |
| `createOrg({ external_id, name, currency?, shop_domains?, shop_domain? })` | `POST /v1/partner/orgs` | `CreateOrgResult`: the org, `created`, and a one-time `api_key` on first creation. Idempotent on `external_id`. |
| `getOrg(orgId)` | `GET /v1/partner/orgs/:id` | `PartnerOrg` |
| `listOrgs({ limit?, after?, externalId? })` | `GET /v1/partner/orgs` | `{ orgs, next_after }`, oldest first |
| `iterateOrgs({ pageSize? })` | pages `listOrgs` | async iterator of `PartnerOrg` |
| `findOrg(externalId)` | `GET /v1/partner/orgs?external_id=` | `PartnerOrg \| null` |
| `updateOrg(orgId, { name?, currency?, shop_domains?, execution_url?, notify_url?, theme? })` | `PATCH /v1/partner/orgs/:id` | `PartnerOrg`. `null` clears an override. |
| `getOrgTheme(orgId)` | `GET /v1/partner/orgs/:id/theme` | the effective `ClearedByTheme \| null` |
| `createOrgKey(orgId, { name? })` | `POST /v1/partner/orgs/:id/keys` | `OrgKey`: a new `cb_live_` key, shown once. Use it with `new ClearedBy({ apiKey })`. |

**Reviewers**

| Method | HTTP | Returns |
| --- | --- | --- |
| `upsertReviewer(orgId, externalSubject, { display_name, role, authority, email?, channels? })` | `PUT /v1/partner/orgs/:id/reviewers/:subject` | `PartnerReviewer & { created }`. `authority` is in minor units. |
| `removeReviewer(orgId, externalSubject)` | `DELETE /v1/partner/orgs/:id/reviewers/:subject` | `PartnerReviewer` (`active: false`) |
| `listReviewers(orgId)` | `GET /v1/partner/orgs/:id/reviewers` | `PartnerReviewer[]`, removed ones included |

**Deciding**

| Method | HTTP | Returns |
| --- | --- | --- |
| `createDecisionToken({ orgId, externalSubject, workItemId?, ttlSeconds?, scope? })` | `POST /v1/auth/decision-token` | `DecisionToken`: single-use, ≤ 300s, names one reviewer |
| `createReadToken({ orgId, externalSubject, workItemId?, ttlSeconds? })` | same, `scope: 'read'` | a reusable read-only token (≤ 900s) |
| `decide(id, { decision, reason?, escalateTo? }, { token })` | `POST /v1/gate/:id/decide` | `PartnerDecideResult`. ClearedBy still checks the reviewer's authority. |

**Items** (read methods take `{ token? }` to read as a reviewer instead of with the partner key)

| Method | HTTP | Returns |
| --- | --- | --- |
| `list(orgId, { status?, reviewer?, reviewerUserId?, actionPrefix?, batchId?, cursor?, limit?, include?, token? })` | `GET /v1/gate?org_id=` | `{ items, next_cursor }` |
| `get(orgId, id, { include?, token? })` | `GET /v1/gate/:id/detail?org_id=` | `Clearance` |
| `status(orgId, id, { token? })` | `GET /v1/gate/:id?org_id=` | `GateResult` |
| `events(orgId, id, { lineage?, token? })` | `GET /v1/gate/:id/events?org_id=` | `ClearanceEvent[]` |
| `permissions(orgId, id, reviewer, { token? })` | `GET /v1/gate/:id/permissions?org_id=` | `Permissions` |
| `attachEvidence(orgId, id, [{ type, value, label?, source_ref? }])` | `POST /v1/gate/:id/evidence?org_id=` | `AttachEvidenceResult`: facts your backend looked up, shown as "Verified by <you>" |
| `revoke(orgId, id, reason, { token }?)` | `POST /v1/gate/:id/revoke` | `RevokeResult`, with the partner key or as a named reviewer |
| `withdraw(orgId, id, reason?)` | `POST /v1/gate/:id/withdraw?org_id=` | `WithdrawResult` |

**Approval rules and policies**

| Method | HTTP | Returns |
| --- | --- | --- |
| `getRules(orgId)` | `GET /v1/partner/orgs/:id/rules` | `ApprovalRules`: knobs, plain-English lines, any pending proposal |
| `setRules(orgId, settings)` | `PUT /v1/partner/orgs/:id/rules` | `{ status: 'active' }` if stricter or equal; `{ status: 'needs_owner_approval', proposal_id, summary_diff }` if looser |
| `acceptRules(orgId, proposalId, { token })` | `POST /v1/partner/orgs/:id/rules/:proposal_id/accept` | the activated rules. `token` is an owner/admin decision token. |
| `activatePolicy(orgId, name, version, { token }?)` | `POST /v1/policies/:name/:version/activate` | `PolicyActivation`. The partner key alone may only activate a version that isn't looser. |

`ApprovalRulesSettings` knobs: `tags_auto_max_products`, `inventory_auto_max_items`, `price_changes`, `price_drop_review_pct`, `discounts`, `refund_auto_max`, `refund_dual_above`, `refund_daily_auto_cap`, `refund_per_order_cap`, `order_cancel`, `timeout_hours`, `spot_checks` (random spot-checks, off by default) and `spot_check_pct` (1–25).

**Settings, secrets, data protection**

| Method | HTTP | Returns |
| --- | --- | --- |
| `getSettings()` | `GET /v1/partner/settings` | `PartnerSettings` |
| `updateSettings({ execution_url?, notify_url?, alert_email?, alert_webhook_url?, retention_days?, rotate_alert_webhook_secret?, theme? })` | `PATCH /v1/partner/settings` | `PartnerSettings`, plus `alert_webhook_secret` once when first set or rotated |
| `getSigningSecret(orgId)` | `GET /v1/signing-secrets?org_id=` | the org's `on_decision` secret (a string), for `verifyDispatch` |
| `getSigningSecrets(orgId)` | same | the full `SigningSecrets` view |
| `eraseSubject(orgId, subjectId)` | `POST /v1/partner/orgs/:id/erasure` | `OrgErasureResult`. The subject goes in the body, never the URL. Idempotent. |
| `eraseSubjectEverywhere(subjectId)` | `POST /v1/partner/erasure` | `PartnerErasureResult`: every org you own; retry while `complete: false` |

Webhook subscriptions are per org and need the org key: `new ClearedBy({ apiKey }).createWebhook(...)` with the key from `createOrg` / `createOrgKey`.

### Embedded approval UI: `@clearedby/sdk/partner-proxy`

The server half of [`@clearedby/react`](../react). One route in your app; the
browser never sees your partner key or any ClearedBy token.

```ts
// app/api/clearedby/[...path]/route.ts (Next.js App Router)
import { createPartnerProxy } from '@clearedby/sdk/partner-proxy'

const proxy = createPartnerProxy({
  partnerKey: process.env.CLEAREDBY_PARTNER_KEY!,
  // From YOUR session. The org and person come only from here (null → 401).
  resolveUser: async (req) => (await mySession(req))?.clearedby ?? null, // { org_id, external_subject }
})
export const GET = proxy.handle, POST = proxy.handle, PUT = proxy.handle
```

Express: `app.use('/api/clearedby', expressHandler(proxy))`. It serves a fixed
list of routes (queue, item, history, permissions, decide, revoke, rules,
accept, theme) and nothing else, mints a cached read-only token per person for
reads and a fresh single-use token pinned to the item for each decision, strips
tokens and receipts from responses, and refuses cross-site writes. Options:
`baseUrl`, `basePath` (default `/api/clearedby`), `canEditRules(user, req)`,
`allowedOrigins`, `readTokenTtlSeconds`, `fetch`.

## Errors

- `ClearedByApiError`: any non-2xx answer from the API, and a `wait()` timeout (status 408, code `timeout`). It carries `status`, `code` (the API's stable `error.code`, e.g. `no_authority`, `subject_id_required`), `message`, `hint` and `details` (structured detail from the error envelope), plus the raw `body`. `ClearedByError` is the same class under its older name, so existing `instanceof ClearedByError` checks keep working.
- `RejectedError`: `guard()` only. The action was rejected, expired, revoked or withdrawn (`.result` holds the gate result and reason).
- `SentBackError`: `guard()` only. A reviewer returned the action to revise (`.result.reason` is the note, `.result.id` is the parent to `resubmit()` against).
- `TestItemError`: `guard()` only. The item is a dashboard test item and never authorizes anything.

```ts
import { ClearedByApiError } from '@clearedby/sdk'

try {
  await partner.createOrg({ external_id: 'shop_1', name: 'Acme', currency: 'XXX' })
} catch (e) {
  if (e instanceof ClearedByApiError && e.code === 'invalid_body') console.log(e.status, e.message, e.hint)
  else throw e
}
```

Every cleared/rejected decision is signed into your org's tamper-evident attestation chain — see the dashboard ledger.
