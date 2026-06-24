# @clearedby/mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server that lets an AI agent (Claude Code/Desktop, or any MCP client) gate its own consequential actions through [ClearedBy](https://clearedby.com).

## Tools

| Tool | What it does |
|------|--------------|
| `request_clearance` | Gate an action. Returns **cleared** (safe to proceed), **rejected** (do NOT proceed), or **sent_back** (revise & resubmit — *not* a rejection). If held for a human it waits up to 10 minutes. |
| `check_policy` | Dry-run: preview what the policy *would* decide, recording nothing. |
| `get_ledger` | Recent entries from the tamper-evident attestation ledger. |

### The revise loop (sent_back)

A reviewer can **send an action back to revise** instead of approving or rejecting it
— "almost, but cap it at £100." That's a first-class verdict, not a failure:

- `request_clearance` returns `sent_back` with the reviewer's `reason` and a
  `parent_item_id`.
- The agent revises the action to address the note, then calls `request_clearance`
  again **with `parentItemId` set to that `parent_item_id`**.
- Every attempt links to its parent, so the whole human↔agent negotiation is one
  auditable lineage in the ledger.

An agent that treats `sent_back` as a rejection throws away the feedback loop that
makes a human-in-the-loop worth having.

### Proof cases & evidence

Pass the **case** for an action — not just the action — so the reviewer can decide in seconds.
`request_clearance` takes `confidence`, `reason`, `recommendedOutcome`, `riskFlags`, and typed `evidence` cards:

```jsonc
request_clearance {
  "action": "refund.create",
  "params": { "amount": 420, "order": "SO-118" },
  "reason": "Item arrived damaged; delivery confirmed.",
  "confidence": 0.9,
  "recommendedOutcome": "approve_refund",
  "evidence": [
    { "type": "threshold", "value": { "label": "Refund vs order total", "value": 420, "limit": 400, "unit": "£" } },
    { "type": "entity",    "value": { "name": "a.popov@example.com", "fields": [{ "label": "Prior refunds", "value": 1 }] } },
    { "type": "timeline",  "value": [{ "label": "Damage reported", "at": "Jun 10" }] },
    { "type": "source",    "value": { "title": "Support ticket #4821", "snippet": "…arrived cracked…" } }
  ]
}
```

The reviewer sees friendly cards (`threshold`, `entity`, `timeline`, `table`, `media`, `source`, `conversation`;
any other type falls back to a generic card). `conversation` is a chat/support thread, rendered as bubbles. ClearedBy **presents** the case and pins it, tamper-evident, to the decision — it
never claims the evidence is *true*; the human rules on it. Same vocabulary as the [SDK](../sdk#proof-cases--evidence).

## Run it

```bash
CLEAREDBY_API_KEY=cb_live_… npx @clearedby/mcp
```

Optional: `CLEAREDBY_BASE_URL` (defaults to `https://app.clearedby.com`).

### Claude Desktop / Claude Code config

```jsonc
{
  "mcpServers": {
    "clearedby": {
      "command": "npx",
      "args": ["@clearedby/mcp"],
      "env": { "CLEAREDBY_API_KEY": "cb_live_…" }
    }
  }
}
```

## Example

> **Agent:** I'm about to issue a £400 refund on order SO-118.
> *calls `request_clearance { action: "refund.create", params: { amount: 400, order: "SO-118" } }`*
> **ClearedBy:** ↩️ Sent back to revise: "Goodwill cap is £100 — refund the difference as store credit." *(parent_item_id: `wi_abc`)*
> **Agent:** *revises, then calls `request_clearance { action: "refund.create", params: { amount: 100, order: "SO-118" }, parentItemId: "wi_abc" }`*
> **ClearedBy:** ✅ Approved by a reviewer · attestation 9f2c1a. Safe to proceed.

The agent never decides for itself — policy clears the safe ones, a human approves, rejects, or **sends back** the rest, and every step (including the revise) is signed into your org's audit chain.

Built on [`@clearedby/sdk`](../sdk).
