# policy-tour

Dry-run `check()` one representative action per rule across **every example policy**, and print the verdict matrix. `check()` records nothing — no work item, no attestation — so it's the safe way to confirm your policies are activated and behaving before wiring up real `gate()` calls.

```bash
CLEAREDBY_API_KEY=cb_live_… pnpm start
```

```
# finance-ops
  payout.create {"amount":750}        → auto         rules[0]: payout.create amount <= 1000
  payout.create {"amount":6000}       → review       rules[1]: payout.create amount <= 10000
  payout.create {"amount":40000}      → dual_review  rules[2]: payout.create
  wire.send {"amount":30000}          → reject       rules[3]: wire.send amount >= 25000
  treasury.rebalance                  → reject        (unmatched)
```

A policy that isn't activated yet shows an error on its row — paste its YAML from
[`clearedby-live-tester/policies`](../../../clearedby-live-tester/policies) into **Policies → Activate**.
