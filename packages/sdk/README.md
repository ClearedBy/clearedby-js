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

## API

### `new ClearedBy({ apiKey, baseUrl?, fetch? })`
`baseUrl` defaults to `https://app.clearedby.com`. Pass `fetch` to inject an implementation.

### `gate(input) → GateResult`
`input`: `{ action, params?, context?, policy?, mode?, callbackUrl?, timeout? }`. Returns `{ id, status: 'cleared' | 'rejected' | 'pending', … }`. In shadow mode the call never blocks and returns `{ status: 'cleared', shadow: true, would: { verdict, rule } }`.

### `status(id) → GateResult`
Current state of a gated item.

### `wait(id, { timeoutMs?, pollMs? }) → GateResult`
Blocks until the item is `cleared`/`rejected` or the timeout elapses (throws `ClearedByError` with status 408 on timeout).

### `guard(input, fn) → fn's return`
Gates, then runs `fn` only if cleared (immediately, or after `wait` resolves a held item). Throws `RejectedError` if rejected, `ClearedByError` on timeout. In shadow mode `fn` always runs.

## Errors
- `ClearedByError` — non-2xx from the API (`.status`, `.code`, `.body`) or a `wait` timeout.
- `RejectedError` — the action was rejected (`.result` holds the gate result + reason).

Every cleared/rejected decision is signed into your org's tamper-evident attestation chain — see the dashboard ledger.
