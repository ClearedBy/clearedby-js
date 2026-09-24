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
// Production notes: the in-memory Set is a stand-in. Use a durable store with
// an atomic "insert if absent" (a unique index on work_item_id) and write the
// marker BEFORE calling the downstream API, so a crash mid-execution can't
// double-execute. For refunds: re-check the refundable amount at execution
// time, never exceed the approved amount, and pass an idempotency key
// (work_item_id) to the downstream API.

import { DispatchVerificationError, verifyDispatch, type VerifyDispatchOptions } from '@clearedby/sdk/dispatch'

export type Executor = (action: string, params: Record<string, unknown>, workItemId: string) => Promise<{ ref: string }>

export interface ReceiverResult {
  status: number
  body: Record<string, unknown>
}

export function createReceiver(verify: VerifyDispatchOptions, execute: Executor) {
  const executed = new Map<string, { ref: string }>() // work_item_id → result (stand-in for a DB table)
  const inProgress = new Set<string>()

  return async function handle(rawBody: string, headers: Record<string, string | string[] | undefined>): Promise<ReceiverResult> {
    let verified
    try {
      verified = await verifyDispatch(rawBody, headers, verify)
    } catch (err) {
      if (err instanceof DispatchVerificationError) {
        // 401 = "not from ClearedBy / not for us". ClearedBy will retry a
        // non-2xx, so a genuine-but-stale delivery gets another chance with a
        // fresh signature + receipt.
        return { status: 401, body: { error: err.code } }
      }
      throw err
    }
    const { envelope, params } = verified

    // Only cleared verdicts authorize execution. Acknowledge the rest.
    if (envelope.verdict !== 'cleared') return { status: 200, body: { status: 'noted', verdict: envelope.verdict } }

    const id = envelope.work_item_id
    const prior = executed.get(id)
    if (prior !== undefined || inProgress.has(id)) {
      return { status: 409, body: { status: 'already_executed', ...(prior ? { ref: prior.ref } : {}) } }
    }
    inProgress.add(id)
    try {
      const result = await execute(envelope.action, params, id)
      executed.set(id, result)
      return { status: 200, body: { status: 'executed', ref: result.ref } }
    } finally {
      inProgress.delete(id)
    }
  }
}
