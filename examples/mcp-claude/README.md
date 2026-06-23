# Gate Claude's actions via MCP

Give **Claude Code / Claude Desktop** (or any MCP client) the ability to gate its
own consequential actions through ClearedBy — no SDK code required. The
[`@clearedby/mcp`](../../packages/mcp) server exposes three tools:

| Tool | What it does |
|------|--------------|
| `request_clearance` | Gate an action → **cleared** / **rejected** / **sent_back** (revise & resubmit). Waits up to 10 min if held for a human. |
| `check_policy` | Dry-run: what would the policy decide, recording nothing. |
| `get_ledger` | Recent tamper-evident attestations. |

## Configure

Add the server to your MCP client config (e.g. Claude Desktop's
`claude_desktop_config.json`):

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

Use an **agent-bound** key (ClearedBy → Settings → API keys, bound to an agent) so
each action is attributed to a verified agent. Optional: `CLEAREDBY_BASE_URL`
(defaults to `https://app.clearedby.com`).

## In practice

> **You:** Refund £400 on order SO-118.
> **Claude:** *calls* `request_clearance { action: "refund.create", params: { amount: 400, order: "SO-118" }, model: "claude-opus-4-8", confidence: 0.9, reason: "item arrived damaged" }`
> **ClearedBy:** ↩️ Sent back to revise: "Goodwill cap is £100." *(parent_item_id: wi_abc)*
> **Claude:** *revises, then* `request_clearance { …, amount: 100, parentItemId: "wi_abc" }`
> **ClearedBy:** ✅ Approved by a reviewer. Safe to proceed.

The agent never decides for itself — policy clears the safe ones, a human approves,
rejects, or **sends back** the rest, and every step is signed into your org's chain.

See also: [`shopify-refund-agent`](../shopify-refund-agent) for the same revise loop
via the SDK.
