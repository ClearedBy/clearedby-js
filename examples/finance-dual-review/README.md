# finance-dual-review

A **verified agent** moves money under the `finance-ops` policy, showing three controls the other examples don't:

1. **A hard reject** — `wire.send` ≥ £25,000 is policy-blocked. No human can override a `reject`.
2. **`dual_review` + `passkey`** — a £40,000 payout needs **two** distinct approvers, one signing with a **WebAuthn passkey**. (Without a passkey, the decide call returns `401 passkey_required`.)
3. **Tier-3 proof-of-execution** — once cleared, the agent executes and calls `complete()` with an `external_ref` an auditor can verify at the source.

## Run

Use an **agent-bound** key so the doer is *verified* (the binding is the proof, not a string in the body):

```bash
CLEAREDBY_API_KEY=cb_live_…   # ClearedBy → Settings → Agents → mint a key
pnpm start
```

Then open the workspace link it prints and **approve the payout with two reviewers, one using a passkey**. The script resumes, executes, and records Tier-3 proof.

## Setup it depends on
- `finance-ops` activated (paste [the YAML](../../../clearedby-live-tester/policies/finance-ops.yaml) → Activate).
- An **agent** with a bound key (Settings → Agents).
- **Two reviewers** with covering authority for `payout.create`, both with a **passkey** enrolled.
