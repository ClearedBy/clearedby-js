# Dispatch receiver (on_decision v2)

A partner **execution endpoint**: ClearedBy decides, then POSTs the decision to
you (`on_decision`), and you execute it: a refund, a discount, a publish. This
example shows how to do that safely:

1. **Verify** every POST with `verifyDispatch` from `@clearedby/sdk/dispatch`.
   That checks the timestamped signature, and for cleared decisions the signed
   Authorization Receipt that binds the POST to this exact org, work item,
   action and params.
2. **Dedupe on `work_item_id`.** Delivery is at-least-once: timeouts, retries
   and manual redelivers can send the same decision again. Each attempt carries
   a fresh receipt with a new nonce, so don't dedupe on the nonce.
3. **Answer `409 {"status":"already_executed"}`** on a repeat. ClearedBy counts
   a 409 as delivered and stops retrying.
4. **Execute only from the receipt's params** (`params` returned by
   `verifyDispatch`).

The full contract is in [`docs/dispatch-contract.md`](../../docs/dispatch-contract.md).

## Try it offline

```bash
pnpm demo
```

This plays ClearedBy's side locally with a throwaway key and prints:

```
1. first delivery: 200 {"status":"executed","executed":true,"execution_id":"re_demo_1"}
2. retry (attempt 2, fresh receipt): 409 {"status":"already_executed","executed":false,"execution_id":"re_demo_1"}
3. forged amount: 401 {"error":"receipt_mismatch"}
```

## Run it for real

```bash
CLEAREDBY_SIGNING_SECRET=odsec_...           # the credential's secret, or GET /v1/signing-secrets
CLEAREDBY_AUDIENCE=https://exec.you.example  # optional; must match `audience` sent at gate time
CLEAREDBY_EXECUTOR_KEY=cb_live_...           # optional; reports completion with complete()
pnpm start                                   # listens on :8787/on-decision
```

A partner serving many orgs sets `CLEAREDBY_PARTNER_KEY` instead of
`CLEAREDBY_SIGNING_SECRET`: each org's secret is then looked up (and cached)
by the envelope's `org_id`. The receiver verifies with `checkStatus: true`, so
an approval revoked after it was dispatched answers `200 {"status":"revoked"}`
and runs nothing.

Policy:

```yaml
on_decision:
  cleared:
    url: https://exec.you.example/on-decision
    auth: exec-credential   # optional; signs with that credential's odsec_ secret
```

## Check it with the doctor

```bash
CLEAREDBY_PARTNER_KEY=cb_partner_... npx @clearedby/sdk doctor --full --audience https://exec.you.example
```

The receiver passes every check (`packages/sdk/test/doctor.test.ts` runs it
against a fake ClearedBy). What makes it pass:

- requests with `clearedby-doctor: 1` are dry runs: verified and deduped as
  usual, never executed or recorded;
- the action `doctor.noop` is recorded (so a replay gets `409`) and reported
  done, but never executed;
- answers carry the optional contract `{ status, executed, execution_id }`, so
  the doctor can prove a replay wasn't executed twice.

With `--full`, ClearedBy's real dispatch goes to your configured
`execution_url` (a tunnel in development). Completion is only reported when
`CLEAREDBY_EXECUTOR_KEY` is a key for the org being tested.

## In production

- Replace the in-memory `Map` with a durable table with a unique index on
  `work_item_id`, and write the "executing" marker **before** calling the
  downstream API.
- Refunds: re-check the refundable amount at execution time, never exceed the
  approved amount, and pass `work_item_id` as the downstream idempotency key.
- If you missed deliveries, check `GET /v1/gate/:id/delivery` and call
  `POST /v1/gate/:id/redeliver`.
