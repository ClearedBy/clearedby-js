# Receipt-gated MCP server — verify, don't trust

A **third-party MCP server** ("Partner Billing") that enforces ClearedBy
authorization **without trusting ClearedBy**: it holds no ClearedBy API key,
makes no ClearedBy call at decision time, and decides every tool call locally —

> *Give me the receipt. I verify it here. If it authorizes this exact action,
> for this audience (me), and hasn't expired — I execute.*

Its only ClearedBy contact, ever, is fetching the **published public keys**
(`/.well-known/clearedby-keys`) once at boot — a public, unauthenticated
document. Look at [`src/server.ts`](src/server.ts)'s imports: the offline
verifier (`@clearedby/sdk/receipt`) and nothing else.

## The loop

```
AGENT (holds the ClearedBy key)              PARTNER (holds NO key)
────────────────────────────────             ─────────────────────────────
gate refund.create,
  audience = mcp://partner-billing.example
        │
        ▼
signed Authorization Receipt ───────────────▶ verifyReceipt()  · offline
                                              nonce replay guard
                                              own ceiling on SIGNED params
                                                    │
                                                    ▼
record completion on the ledger ◀─────────── execute → execution proof
(authorized → executed → matched)
```

Three enforcement layers in the server, each real:

1. **`verifyReceipt()`** — signature, freshness, audience + action binding.
   Tamper with anything signed — amount, target, expiry, agent — and it reads
   as `bad_signature`.
2. **Nonce replay** — a receipt authorizes **one** execution here; seen nonces
   are refused for the TTL window.
3. **The partner's own constraints** — a local refund ceiling applied to the
   **signed** params. The tool takes *no* arguments besides the receipt;
   execution derives entirely from the signed statement.

## Run the end-to-end demo

```bash
CLEAREDBY_API_KEY=cb_live_… pnpm demo
```

Gates a £250 refund naming the partner as the audience (approve it in the
workspace if your policy holds it), then drives the partner over a real MCP
transport:

```
[agent]   cleared — receipt 01J… (expires …)
[partner] genuine receipt   → EXECUTED: {"executed":true,"external_ref":"rf_…","amount":250,…}
[partner] tampered (400)    → REFUSED: bad_signature
[partner] replayed receipt  → REFUSED: replayed nonce — this receipt was already used
[agent]   completion recorded on the ledger (rf_…) — authorized → executed → matched.
```

## Run as a real MCP server (Claude Desktop / Claude Code)

```bash
PARTNER_AUDIENCE=mcp://partner-billing.example pnpm start
```

or in an MCP client config:

```jsonc
{
  "mcpServers": {
    "partner-billing": {
      "command": "npx",
      "args": ["tsx", "examples/receipt-gated-mcp-server/src/index.ts"],
      "env": { "PARTNER_AUDIENCE": "mcp://partner-billing.example" }
    }
  }
}
```

The agent side then gates with `audience: "mcp://partner-billing.example"` and
passes `r.receipt` to the `issue_refund` tool.

## Notes

- Receipts are issued on **enforce-mode cleared** verdicts under an Ed25519
  signing key, and expire ~10 minutes after issuance — the short TTL is the
  revocation story.
- The receipt's `context_hash` attests what ClearedBy **evaluated**, not that
  the evidence is true.
- See also: [`callback-receiver`](../callback-receiver) (signed verdict
  webhooks) · [`shopify-refund-agent`](../shopify-refund-agent) (the blocking
  + revise loop) · the SDK README's *Authorization Receipts* section.
