# ClearedBy — JavaScript clients

Official JavaScript / TypeScript clients for **[ClearedBy](https://clearedby.com)**, the approval &
attestation layer for automated systems. Gate a consequential action → policy clears it, rejects it,
or holds it for a human → every decision is signed into a tamper-evident chain.

## Packages

| Package | What it is |
| --- | --- |
| [`@clearedby/sdk`](packages/sdk) | Tiny, dependency-free client — `gate()` / `wait()` / `guard()` an agent action. Works anywhere `fetch` exists. |
| [`@clearedby/mcp`](packages/mcp) | MCP server — gate actions from Claude Code/Desktop or any MCP client. |

## Examples

- [`examples/shopify-refund-agent`](examples/shopify-refund-agent) — a Shopify merchant's AI agent issues a
  refund through the full loop: propose → gate → a human approves or **sends it back** → the agent revises
  and resubmits → executes → records proof.

## Quick start

```bash
npm install @clearedby/sdk
```

```ts
import { ClearedBy } from '@clearedby/sdk'

const cb = new ClearedBy({ apiKey: 'cb_live_…' })

await cb.guard(
  { action: 'refund.create', params: { amount: 250, order: 'SO-118' } },
  () => issueRefund(),
)
```

## Links

- Docs & dashboard: https://clearedby.com
- npm: [`@clearedby/sdk`](https://www.npmjs.com/package/@clearedby/sdk) · [`@clearedby/mcp`](https://www.npmjs.com/package/@clearedby/mcp)

## License

MIT
