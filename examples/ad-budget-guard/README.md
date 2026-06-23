# Ad budget guard — a different action, dry-run + poll

A marketing agent wants to launch a paid campaign. ClearedBy gates `ad.launch`
the same way it gates a refund — the gate is **domain-agnostic**. This example
shows two patterns the refund demo doesn't:

- **`check()` first** — a dry-run that previews the policy verdict (*"would this
  need approval?"*) and records nothing.
- **Poll** — submit with `gate()`, then call `status()` on your own cadence
  instead of blocking. (For long waits, prefer a `callbackUrl` — see
  [`callback-receiver`](../callback-receiver).)

## Run it

```bash
CLEAREDBY_API_KEY=cb_live_… pnpm start
```

With a policy that auto-clears small budgets and routes big ones to review:

```
🤖 Ads agent wants to launch "Summer Sale" at £800/day.

check(): policy would → review (rule rules[1]). Nothing recorded.

⏳ Held for review (item wi_…). Polling every 3s — decide it in the workspace…
   …still pending
✅ Approved by a reviewer.
🚀 Launching "Summer Sale" — £800/day on meta.
```

See also: [`@clearedby/sdk`](../../packages/sdk) for the full `gate` / `check` /
`status` / `wait` / `guard` API.
