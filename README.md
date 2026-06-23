# ClearedBy — JavaScript clients

Official JavaScript / TypeScript clients for **[ClearedBy](https://clearedby.com)**, the approval &
attestation layer for automated systems. **Gate** a consequential action before it happens → policy
clears it, rejects it, or holds it for a human → every decision is signed into a tamper-evident chain.

```ts
import { ClearedBy } from '@clearedby/sdk'
const cb = new ClearedBy({ apiKey: 'cb_live_…' })

// The body runs only if the action clears — now, or after a human approves.
await cb.guard(
  { action: 'refund.create', params: { amount: 250, order: 'SO-118' } },
  () => issueRefund(),
)
```

---

## Packages

| Package | Use it when |
| --- | --- |
| [`@clearedby/sdk`](packages/sdk) | You're writing code. Tiny, dependency-free; works anywhere `fetch` exists (Node 18+, edge, browser). |
| [`@clearedby/mcp`](packages/mcp) | You want **Claude Code/Desktop or any MCP client** to gate its own actions — no SDK code. |

There's also an n8n community node (`n8n-nodes-clearedby`) for no-code workflows.

---

## How the gate works

Every call describes an **action** (`action` + `params`) and gets back a **verdict**:

| Verdict | Meaning |
| --- | --- |
| `cleared` | Policy allows it (or a human approved). Safe to proceed. |
| `rejected` | Policy or a human said no. Do **not** proceed. |
| `sent_back` | "Revise & resubmit" — a human returned it with a note. **Not** a rejection. |
| `pending` | Held for a human; you choose how to wait (below). |

Pass `policy: '<name>'` to target a named policy, or omit it for the org default. In shadow mode
nothing blocks — you get `{ status: 'cleared', shadow: true, would: { verdict, rule } }`. Preview a
verdict without recording anything with `cb.check(input)`.

---

## Waiting for a human — three patterns

A held action waits for a person. Pick the one that fits your runtime:

### 1. Block — simplest, for short / in-session decisions
```ts
await cb.guard(input, () => doIt())          // runs doIt() only once cleared
// or: const r = await cb.gate(input); const final = await cb.wait(r.id)
```

### 2. Fire-and-forget — for long / out-of-hours reviews (hold no compute)
Pass a `callbackUrl`; ClearedBy POSTs the verdict to you when a human decides — minutes or days later.

```ts
const r = await cb.gate({ ...input, callbackUrl: 'https://your-app.com/hooks/clearedby' })
// r.status === 'pending' — return now. Later, ClearedBy POSTs:
//   { id, status: 'cleared' | 'rejected' | 'sent_back', reason, attestation: { seq, hash } }
```

**Verify the callback is genuinely from ClearedBy** (anyone who learns the URL could forge a POST):
the gate response's **`r.resume.signing_secret`** is your HMAC key, and each POST carries

```
X-ClearedBy-Signature: sha256=hmac(signing_secret, rawBody)
```

Recompute it over the raw body and compare (constant-time) before acting. Full working receiver:
[`examples/callback-receiver`](examples/callback-receiver).

### 3. Poll — the middle ground
```ts
const r = await cb.gate(input)
// …later, on your own cadence:
const s = await cb.status(r.id)               // 'cleared' | 'rejected' | 'pending' | 'sent_back'
```

---

## The send-back (revise) loop

A reviewer can **return** an action to revise instead of approving or rejecting it ("cap it at £100").
`guard()` throws `SentBackError`; catch it, regenerate, and `resubmit()` on the same lineage:

```ts
import { SentBackError } from '@clearedby/sdk'
let input = { action: 'refund.create', params: { amount: 250 } }
for (;;) {
  try { await cb.guard(input, () => doIt()); break }
  catch (e) {
    if (e instanceof SentBackError) {
      input = revise(input, e.result.reason)   // your regeneration, using the note
      input.parentItemId = e.result.id          // keep the revise chain auditable
      continue
    }
    throw e
  }
}
```

This is the headline human-in-the-loop pattern — see [`examples/shopify-refund-agent`](examples/shopify-refund-agent).

---

## Proof-of-execution

After you actually carry out a cleared action, record that you did it onto the attestation chain — so the
ledger shows *verifiably done*, not just "we approved it":

```ts
await cb.complete(itemId, {
  status: 'done',                               // 'done' | 'failed' | 'partial'
  externalRef: 'gid://shopify/Refund/123',
  evidence: [{ type: 'shopify_refund', value: 'gid://…' }],
})
```

---

## Verified agent identity

Use an **agent-bound** API key (ClearedBy → Settings → Agents → mint a key) so every gate call is
attributed to a *verified* doer — recorded on the work item and in the ledger — rather than an
unverified `agent_id` string in the request body. Same API; the binding is what makes "which agent did
this, prove it" hold.

---

## Outbound actions (`on_decision`)

When you'd rather have ClearedBy drive the side-effect than poll for it, a **policy** can POST to your
system on a verdict — with configurable auth headers (encrypted, set in Integrations → Outbound) and an
`X-ClearedBy-Signature` you verify the same way. Use `callbackUrl` when the **agent** wants notifying;
use `on_decision` when the **org/policy** owns the downstream action.

---

## Examples

Each shows a different pattern — full index in [`examples/`](examples).

| Example | Pattern |
|---|---|
| [`shopify-refund-agent`](examples/shopify-refund-agent) | **block + revise** — guard, send-back loop, execute, proof |
| [`callback-receiver`](examples/callback-receiver) | **fire-and-forget** — `callbackUrl` + signature verification |
| [`ad-budget-guard`](examples/ad-budget-guard) | **dry-run + poll** — `check()` then `gate`/`status` on `ad.launch` |
| [`mcp-claude`](examples/mcp-claude) | **MCP** — gate Claude's actions, no SDK code |

---

## Quick start

```bash
npm install @clearedby/sdk
```

Get an API key from **ClearedBy → Settings**, then gate your first action with the `guard()` snippet at
the top. Full API: [`@clearedby/sdk`](packages/sdk).

## Links

- Docs & dashboard: https://clearedby.com
- npm: [`@clearedby/sdk`](https://www.npmjs.com/package/@clearedby/sdk) · [`@clearedby/mcp`](https://www.npmjs.com/package/@clearedby/mcp)

## License

MIT

---

> This repository is a **read-only mirror**, generated from ClearedBy's private monorepo. Open issues here,
> but code changes are made upstream and synced automatically — PRs against this repo can't be merged directly.
