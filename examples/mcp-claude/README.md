# Gate Claude's actions via MCP

Give **Claude Code / Claude Desktop** (or any MCP client) the ability to gate its
own consequential actions through ClearedBy — **no SDK code**. The
[`@clearedby/mcp`](../../packages/mcp) server exposes three tools:

| Tool | What it does |
|------|--------------|
| `request_clearance` | Gate an action → **cleared** / **rejected** / **sent_back** (revise & resubmit). Waits up to 10 min if held for a human. |
| `check_policy` | Dry-run: what would the policy decide, recording nothing. |
| `get_ledger` | Recent tamper-evident attestations. |

## Try it in 4 steps

**1. Mint an agent-bound key** — ClearedBy → Settings → **Agents** → create `support-bot` → mint a key (`cb_live_…`). Binding the key to an agent is what makes Claude a *verified* doer on the ledger.

**2. Add the server to your client config:**

Claude Desktop — `claude_desktop_config.json`:
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

Claude Code — `claude mcp add clearedby --env CLEAREDBY_API_KEY=cb_live_… -- npx @clearedby/mcp`

(Optional `CLEAREDBY_BASE_URL`, defaults to `https://app.clearedby.com`.)

**3. Restart the client**, then prompt Claude to do something consequential:

> **You:** Issue a £842 refund on order SO-4471.
> **Claude:** *calls* `request_clearance { action: "refund.create", params: { amount: 842, order: "SO-4471" }, model: "claude-opus-4-8", confidence: 0.9, reason: "item arrived damaged" }`
> **ClearedBy:** ⏳ held for review.

**4. Open the workspace and send it back** with a note like *"Goodwill cap is £100"*:

> **ClearedBy:** ↩️ Sent back to revise: "Goodwill cap is £100." *(parent_item_id: `wi_abc`)*
> **Claude:** *revises, then* `request_clearance { …, amount: 100, parentItemId: "wi_abc" }`
> **ClearedBy:** ✅ Approved by a reviewer. Safe to proceed.

The agent never decides for itself — policy clears the safe ones, a human approves, rejects, or **sends back** the rest, and every step (including the revise) is signed into your org's chain.

> Want a higher-stakes loop? Point the key's agent at the `finance-ops` or `banking-ops` policy and ask Claude to "extend an overdraft by £12,000" — it'll hit `dual_review + passkey`.

See also: [`shopify-refund-agent`](../shopify-refund-agent) for the same revise loop via the SDK, and the **gallery** (`clearedby-live-tester`) scenario 33.
