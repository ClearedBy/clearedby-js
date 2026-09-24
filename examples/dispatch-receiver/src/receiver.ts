// A partner execution endpoint for ClearedBy's on_decision dispatch (v2).
//
// The four rules this file exists to show:
//   1. VERIFY before anything else: verifyDispatch checks the timestamped
//      HMAC, the envelope, and (for cleared) the Ed25519 receipt bound to this
//      exact org + work item + action + params.
//   2. DEDUPE on work_item_id: delivery is at-least-once (timeouts, retries,
//      manual redeliver). Never dedupe on the receipt nonce; every attempt
//      carries a freshly minted receipt with a new nonce.
//   3. ANSWER 409 {"status":"already_executed"} on a repeat: ClearedBy records
//      a 409 as delivered, so retries stop.
//   4. EXECUTE ONLY FROM THE RECEIPT'S PARAMS: `params` returned by
//      verifyDispatch are the receipt-signed params, never anything else in
//      the request.
//
// It also passes `npx @clearedby/sdk doctor` (CLE-226):
//   - a revoked approval (checkStatus) answers 200 {"status":"revoked"} and
//     executes nothing; an unreachable status endpoint answers 503 (retry);
//   - `doctor.noop` is never executed: verified and deduped as usual, then
//     reported done (unless params.skip_complete) without touching anything;
//   - a request carrying `clearedby-doctor: 1` is a dry run: verified and
//     deduped as usual, never executed or recorded;
//   - answers carry the optional response contract
//     `{ status, executed, execution_id? }` so the doctor can prove idempotency.
//
// Production notes: the in-memory Map is a stand-in. Use a durable store with
// an atomic "insert if absent" (a unique index on work_item_id) and write the
// marker BEFORE calling the downstream API, so a crash mid-execution can't
// double-execute. For refunds: re-check the refundable amount at execution
// time, never exceed the approved amount, and pass an idempotency key
// (work_item_id) to the downstream API.

import { DispatchVerificationError, ReceiptRevokedError, verifyDispatch, type VerifyDispatchOptions } from '@clearedby/sdk/dispatch'

export type Executor = (action: string, params: Record<string, unknown>, workItemId: string) => Promise<{ ref: string }>

/** Report the outcome (POST /v1/gate/:id/complete), e.g. `new ClearedBy({ apiKey }).complete(...)`. */
export type Reporter = (workItemId: string, input: { status: 'done'; completionId: string; deliveryReceiptId?: string; externalRef?: string }) => Promise<unknown>

export interface ReceiverResult {
  status: number
  body: Record<string, unknown>
}

export interface ReceiverOptions {
  /** Resolve the signing secret per org (e.g. partner.getSigningSecret(orgId), cached). Overrides `verify.secret`. */
  secretFor?: (orgId: string) => Promise<string | string[]>
  /** Report completion after executing. Without it, nothing is reported. */
  complete?: Reporter
}

/** The action `npx @clearedby/sdk doctor` proposes and sends. Never execute it. */
const DOCTOR_ACTION = 'doctor.noop'

export function createReceiver(verify: VerifyDispatchOptions, execute: Executor, opts: ReceiverOptions = {}) {
  const executed = new Map<string, { ref: string }>() // work_item_id → result (stand-in for a DB table)
  const inProgress = new Set<string>()

  return async function handle(rawBody: string, headers: Record<string, string | string[] | undefined>): Promise<ReceiverResult> {
    let verified
    try {
      let secret = verify.secret
      if (opts.secretFor !== undefined) {
        // Only to CHOOSE the secret: the HMAC must then match that org's
        // secret, and `orgId` binds the signed body to the same org.
        let orgId: unknown
        try {
          orgId = (JSON.parse(rawBody) as { org_id?: unknown }).org_id
        } catch {
          orgId = undefined
        }
        if (typeof orgId !== 'string' || orgId === '') return { status: 401, body: { error: 'malformed_envelope' } }
        secret = await opts.secretFor(orgId).catch(() => '')
        verified = await verifyDispatch(rawBody, headers, { ...verify, secret, orgId })
      } else {
        verified = await verifyDispatch(rawBody, headers, { ...verify, secret })
      }
    } catch (err) {
      // Revoked after approval: don't execute; 2xx so it isn't retried.
      if (err instanceof ReceiptRevokedError) return { status: 200, body: { status: 'revoked', executed: false } }
      if (err instanceof DispatchVerificationError) {
        // Couldn't ask whether it was revoked: fail closed, ClearedBy retries.
        if (err.code === 'status_unavailable') return { status: 503, body: { error: err.code } }
        // 401 = "not from ClearedBy / not for us". ClearedBy will retry a
        // non-2xx, so a genuine-but-stale delivery gets another chance with a
        // fresh signature + receipt.
        return { status: 401, body: { error: err.code } }
      }
      throw err
    }
    const { envelope, params, receipt } = verified

    // Only cleared verdicts authorize execution. Acknowledge the rest.
    if (envelope.verdict !== 'cleared') return { status: 200, body: { status: 'noted', verdict: envelope.verdict, executed: false } }

    const id = envelope.work_item_id
    const prior = executed.get(id)
    if (prior !== undefined || inProgress.has(id)) {
      return { status: 409, body: { status: 'already_executed', executed: false, ...(prior ? { execution_id: prior.ref } : {}) } }
    }

    // `clearedby-doctor: 1`: a dry run. Verified and deduped above, so the
    // answer is the one a real delivery would get; nothing runs or is recorded.
    const doctorHeader = headers['clearedby-doctor']
    if ((Array.isArray(doctorHeader) ? doctorHeader[0] : doctorHeader) === '1') {
      return { status: 200, body: { status: 'dry_run', executed: false } }
    }

    inProgress.add(id)
    try {
      if (envelope.action === DOCTOR_ACTION) {
        // A harmless test from the doctor: record it (so a replay is a
        // repeat), touch nothing, and report it done like any real action.
        const result = { ref: `noop_${id}` }
        executed.set(id, result)
        if (opts.complete !== undefined && params.skip_complete !== true) {
          await opts.complete(id, { status: 'done', completionId: `${id}:final`, ...(receipt ? { deliveryReceiptId: receipt.receipt_id } : {}) }).catch((err: unknown) => console.error('complete failed', err))
        }
        return { status: 200, body: { status: 'noop', executed: false } }
      }
      const result = await execute(envelope.action, params, id)
      executed.set(id, result)
      if (opts.complete !== undefined) {
        await opts.complete(id, { status: 'done', completionId: `${id}:final`, externalRef: result.ref, ...(receipt ? { deliveryReceiptId: receipt.receipt_id } : {}) }).catch((err: unknown) => console.error('complete failed', err))
      }
      return { status: 200, body: { status: 'executed', executed: true, execution_id: result.ref } }
    } finally {
      inProgress.delete(id)
    }
  }
}
