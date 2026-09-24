# devops-deploy-dispatch

Deploy gating under the `devops` policy, ending in an outbound **dispatch → Tier-3 completion**:

- **staging deploy** → `auto` (string condition `env != 'production'`).
- **production deploy** → `review`; on approval the policy's `on_decision.cleared` **calls your CI** and captures the run id from the JSON response (`extract: $.runId`) → a **Tier-3** "verifiable" completion, written automatically by ClearedBy (actor `system:dispatch`).

```bash
CLEAREDBY_API_KEY=cb_live_… pnpm start
```

The script gates + waits for the human; the dispatch and completion are server-side, so it then reads the ledger back to show the captured run id.

Depends on: `devops` activated ([YAML](../../../clearedby-live-tester/policies/devops.yaml)); an outbound credential `ci-deploy-token`; and the policy's `on_decision.cleared.url` pointed at a reachable JSON endpoint returning `{ "runId": "…" }` (e.g. the deployed gallery's `/api/exec-receiver`).
