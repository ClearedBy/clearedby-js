# Dogfood demo — a Shopify agent issues a refund through ClearedBy

The end-to-end proof that ClearedBy is an **agent adapter**, not just a webhook:
a Shopify merchant's own AI agent wants to refund an order, and ClearedBy gates
it — policy clears the safe ones, a human approves, rejects, or **sends back**
the rest, the agent revises and resubmits, and every step is signed into the
audit chain.

This is the "overlap case" from [`docs/clearedby-adapters.md`](../../docs/clearedby-adapters.md):
same store, same Core, a different *doer*. The Shopify adapter (CLE-172) lets a
Shopify **Flow** propose the refund; here the merchant's **agent** proposes it,
through the exact same gate, attributed to a verified agent identity (CLE-141).

```
agent proposes  →  ClearedBy gates  →  human approves / rejects / SENDS BACK
                                          │
        ┌── sent_back: agent revises ─────┘
        ▼
agent resubmits (linked to the parent)  →  cleared  →  agent EXECUTES the refund
against Shopify  →  records proof-of-execution into the chain.
```

## What you need

1. **A ClearedBy org** with a policy that routes `refund.create` to **review**
   (so the human-in-the-loop actually fires). The default starter policy does.
2. **An agent-bound API key** — ClearedBy → Settings → API keys → create one and
   bind it to an agent. Binding (CLE-141) is what makes the refund attributable
   to a verified *doer* rather than an anonymous key. Copy the `cb_live_…` value.
3. Shopify is **optional** — the demo stubs the actual refund unless you set
   `SHOPIFY_SHOP` + `SHOPIFY_ADMIN_TOKEN`. The headline (the gate + revise loop)
   runs without a store.

## Run it

```bash
pnpm install                               # from the repo root, once
cd examples/shopify-refund-agent
CLEAREDBY_API_KEY=cb_live_… pnpm start
# optional, to hit a real store:
#   SHOPIFY_SHOP=my-store.myshopify.com SHOPIFY_ADMIN_TOKEN=shpat_… \
#   CLEAREDBY_BASE_URL=https://app.clearedby.com   (defaults to this)
```

The script proposes a £400 refund and then **waits**. Open the ClearedBy
workspace and:

1. **Send it back** with a note like `Goodwill cap is £100`. The script reads the
   note, revises to £100, and resubmits — linked to the original as one lineage.
2. **Approve** the revised £100. The script "executes" the refund (real or
   simulated) and records proof-of-execution.

Console output walks the whole negotiation:

```
🤖 Support agent is handling order SO-118 (GBP 400) for a.popov@example.com.
[attempt 1] Agent proposes: refund GBP 400 — "…arrived damaged…"
⏳ Held for a human (item wi_…). Open the ClearedBy workspace to decide…
↩️  Sent back to revise: "Goodwill cap is £100" — NOT a rejection.
[attempt 2] Agent resubmits (revised): refund GBP 100 — "…(Revised per reviewer…)"
✅ Cleared · attestation 9f2c1a — agent executes the refund.
📜 Proof-of-execution recorded (tier 2) ref=simulated-refund:SO-118:100
```

## How it maps to the SDK

| Step | SDK |
|------|-----|
| Propose / resubmit a revised attempt | `cb.gate(input)` / `cb.resubmit(parentItemId, input)` |
| Wait for a human when held | `cb.wait(id)` (returns on cleared / rejected / **sent_back**) |
| Read the reviewer's revise note | `result.reason` + `result.id` (the parent to resubmit against) |
| Prove the agent actually did it | `cb.complete(id, { status, externalRef, evidence })` (CLE-139) |

The agent's `propose`/`revise` functions are deterministic here so the demo runs
offline; in production they're model calls. Everything else is the real SDK and
the real gate.

See also: [`@clearedby/sdk`](../../packages/sdk) · [`@clearedby/mcp`](../../packages/mcp)
(the same loop as an MCP tool for Claude Code/Desktop).
