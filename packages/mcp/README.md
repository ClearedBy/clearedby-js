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
