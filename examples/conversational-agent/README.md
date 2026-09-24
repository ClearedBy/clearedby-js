# conversational-agent

A **real agent conversation, gated.** A Claude support agent (Anthropic SDK, tool-use loop) talks to a customer and, when a refund is warranted, calls its `issue_refund` tool — which it **cannot execute on its own**. That tool runs the action through **ClearedBy** first: the policy clears it, rejects it, or holds it for a human. The agent reads the verdict and continues the conversation honestly — issues the refund, stands down, or tells the customer it's pending.

This is the piece the other examples only describe in prose: an **LLM deciding to do something consequential, mid-conversation, behind the gate** — with a typed **Proof Case** (`@clearedby/sdk` 0.0.3) so the reviewer sees friendly evidence cards.

```bash
ANTHROPIC_API_KEY=sk-ant-…  CLEAREDBY_API_KEY=cb_live_…  pnpm start
# or open with your own line:
pnpm start "my SO-842 order was way too expensive, I want all my money back"
```

- **SO-118** (£420) clears under the `commerce-ops` ≤£500 rule → the agent issues it and records proof-of-execution.
- **SO-842** (£842) is over the line → the gate holds it → the agent tells the customer it's **pending human approval**, not done.

The agent never decides for itself: policy clears the safe ones, a human takes the rest, and every step is signed into the ledger. Depends on `commerce-ops` being active and a `cb_live_…` key (an agent-bound key makes the doer a verified agent).

Built on the manual tool-use loop (no beta SDK surface) so it stays version-robust; swap in the SDK tool runner if you prefer.
