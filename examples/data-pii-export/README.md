# data-pii-export

Fail-closed data governance under the `data-ops` policy. Where commerce defaults unknown actions to *review*, **data-ops defaults to `reject`** and defaults every human decision to a **passkey** — the right posture for PII.

Four `gate()` calls, four outcomes:

| Action | Verdict |
|--------|---------|
| `data.export` 200 rows, no PII | **auto** |
| `data.export` 5,000 rows **with PII** | **dual_review + passkey** (held) |
| `account.delete` 5,000 accounts | **reject** |
| `anonymize.run` (unknown verb) | **reject** (unmatched default — fail closed) |

```bash
CLEAREDBY_API_KEY=cb_live_… pnpm start
```

Depends on: `data-ops` activated ([YAML](../../../clearedby-live-tester/policies/data-ops.yaml)); two reviewers with `data.export` authority + passkeys (for the PII export).
