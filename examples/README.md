# ClearedBy examples

Runnable examples for [`@clearedby/sdk`](../packages/sdk) and
[`@clearedby/mcp`](../packages/mcp) — each shows a different pattern, so pick the
one that matches how you want to wait for a decision.

| Example | Pattern | Highlights |
|---------|---------|-----------|
| [`shopify-refund-agent`](shopify-refund-agent) | **Block + revise** (`guard` / `resubmit` / `complete`) | A verified agent issues a refund; a human approves or **sends it back**; the agent revises, resubmits, executes, and records proof. |
| [`callback-receiver`](callback-receiver) | **Fire-and-forget** (`callbackUrl`) | Submit and return; ClearedBy POSTs the signed verdict to your webhook. Includes `X-ClearedBy-Signature` verification. |
| [`partner-approvals-next`](partner-approvals-next) | **Embedded approval UI** (`@clearedby/react` + `partner-proxy`) | A Next.js app where a platform's merchants review, approve and adjust their approval rules in the platform's own UI. The partner key never reaches the browser. Shows theme tokens, own classes and own components. |
| [`dispatch-receiver`](dispatch-receiver) | **on_decision receiver** (`verifyDispatch`) | A partner execution endpoint: verify the signed v2 dispatch + receipt, dedupe on `work_item_id`, answer 409 on repeats. Offline `pnpm demo`. |
| [`ad-budget-guard`](ad-budget-guard) | **Dry-run + poll** (`check` / `gate` / `status`) | A different action (`ad.launch`); preview the policy with `check()`, then gate and poll for the decision. |
| [`mcp-claude`](mcp-claude) | **MCP** (no SDK code) | Configure Claude Code/Desktop to gate its own actions via `@clearedby/mcp`. |
| [`policy-tour`](policy-tour) | **Multi-policy `check()`** | Dry-run one action per rule across all 8 example policies; prints the verdict matrix. Zero writes. |
| [`finance-dual-review`](finance-dual-review) | **dual_review + passkey + Tier-3** | A verified agent moves money: a hard reject, two-person + passkey approval, then verifiable proof-of-execution. |
| [`data-pii-export`](data-pii-export) | **Fail-closed governance** | `unmatched: reject` + PII `dual_review`; one domain showing all four verdicts. |
| [`devops-deploy-dispatch`](devops-deploy-dispatch) | **on_decision → Tier-3** | Prod deploy reviewed, then ClearedBy dispatches to CI and captures the run id. |
| [`conversational-agent`](conversational-agent) | **LLM agent + SDK** | A real **Claude** support agent (Anthropic SDK, tool-use loop) gates its own refund mid-conversation — clears, holds, or stands down on the verdict. Needs `ANTHROPIC_API_KEY`. |

The first four pick a **pattern**; the last four pick a **domain / policy** — together they exercise every verdict, completion tier, attest tier, and the agent-bound (verified doer) vs plain-key distinction. The 8 example policies live in [`clearedby-live-tester/policies`](../../clearedby-live-tester/policies) with a setup guide in its `SETUP.md`.

Each code example is a standalone package — `cd` in and `pnpm start` with a
`CLEAREDBY_API_KEY`. See each README for specifics.
