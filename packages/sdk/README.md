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

## API

### `new ClearedBy({ apiKey, baseUrl?, fetch? })`
`baseUrl` defaults to `https://app.clearedby.com`. Pass `fetch` to inject an implementation.

### `gate(input) → GateResult`
`input`: `{ action, params?, context?, policy?, mode?, callbackUrl?, timeout?, parentItemId? }`. Returns `{ id, status: 'cleared' | 'rejected' | 'pending' | 'sent_back', … }`. Omit `policy` to use the org default. In shadow mode the call never blocks and returns `{ status: 'cleared', shadow: true, would: { verdict, rule } }`.

### `status(id) → GateResult`
Current state of a gated item.

### `wait(id, { timeoutMs?, pollMs? }) → GateResult`
Blocks until the item is `cleared`/`rejected` or the timeout elapses (throws `ClearedByError` with status 408 on timeout).

### `guard(input, fn) → fn's return`
Gates, then runs `fn` only if cleared (immediately, or after `wait` resolves a held item). Throws `RejectedError` if rejected, `SentBackError` if a reviewer sends it back to revise, `ClearedByError` on timeout. In shadow mode `fn` always runs.

### `resubmit(parentItemId, input) → GateResult`
Re-open a sent-back action with revised `input`, linked to the original so the whole revise chain stays one auditable lineage. (Same as `gate({ ...input, parentItemId })`.)

### `complete(id, { status, executedParams?, externalRef?, evidence?, result? }) → recorded`
Proof-of-execution: after you actually carry out a cleared action, record that you did it (and what you did) onto the attestation chain. `status` is `'done' | 'failed' | 'partial'`.

## Errors
- `ClearedByError` — non-2xx from the API (`.status`, `.code`, `.body`) or a `wait` timeout.
- `RejectedError` — the action was rejected (`.result` holds the gate result + reason).
- `SentBackError` — a reviewer returned the action to revise (`.result.reason` is the note, `.result.id` is the parent to `resubmit()` against).

Every cleared/rejected decision is signed into your org's tamper-evident attestation chain — see the dashboard ledger.
