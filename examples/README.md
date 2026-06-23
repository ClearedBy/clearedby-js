# ClearedBy examples

Runnable examples for [`@clearedby/sdk`](../packages/sdk) and
[`@clearedby/mcp`](../packages/mcp) — each shows a different pattern, so pick the
one that matches how you want to wait for a decision.

| Example | Pattern | Highlights |
|---------|---------|-----------|
| [`shopify-refund-agent`](shopify-refund-agent) | **Block + revise** (`guard` / `resubmit` / `complete`) | A verified agent issues a refund; a human approves or **sends it back**; the agent revises, resubmits, executes, and records proof. |
| [`callback-receiver`](callback-receiver) | **Fire-and-forget** (`callbackUrl`) | Submit and return; ClearedBy POSTs the signed verdict to your webhook. Includes `X-ClearedBy-Signature` verification. |
| [`ad-budget-guard`](ad-budget-guard) | **Dry-run + poll** (`check` / `gate` / `status`) | A different action (`ad.launch`); preview the policy with `check()`, then gate and poll for the decision. |
| [`mcp-claude`](mcp-claude) | **MCP** (no SDK code) | Configure Claude Code/Desktop to gate its own actions via `@clearedby/mcp`. |

Each code example is a standalone package — `cd` in and `pnpm start` with a
`CLEAREDBY_API_KEY`. See each README for specifics.
