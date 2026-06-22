// Tool logic for the ClearedBy MCP server (CLE-20), kept pure + framework-free
// so it's unit-testable. Each returns { text, cleared?, result } which index.ts
// maps to MCP content. Built on @clearedby/sdk.

import type { ClearedBy, GateResult } from '@clearedby/sdk'
import { RejectedError } from '@clearedby/sdk'

export interface ToolResult {
  text: string
  isError?: boolean
  structured: Record<string, unknown>
}

const hash8 = (h?: string) => (h ? ` · attestation ${h.slice(0, 8)}` : '')

/**
 * A sent-back verdict is "revise & resubmit", NOT a rejection (CLE-140). Surface
 * the reviewer's note + the parent id so the agent can regenerate and resubmit
 * via request_clearance({ parentItemId }). An adapter that collapses this into
 * "rejected" is incomplete (docs/clearedby-adapters.md) — completing the revise
 * loop is the headline agent-adapter capability.
 */
function sentBackResult(res: GateResult): ToolResult {
  return {
    text:
      `↩️ Sent back to revise${res.reason ? `: ${res.reason}` : ''}.\n` +
      `This is NOT a rejection. Revise the action to address that note, then call ` +
      `request_clearance again with parentItemId="${res.id}" to resubmit — that keeps ` +
      `the whole revise chain on one auditable lineage.`,
    structured: { cleared: false, sent_back: true, reason: res.reason ?? null, parent_item_id: res.id, result: res },
  }
}

/** request_clearance: gate the action; if held, wait for a human (≤10 min). */
export async function requestClearance(
  cb: ClearedBy,
  args: {
    action: string
    params?: Record<string, unknown>
    policy?: string
    summary?: string
    agentId?: string // who is proposing (defaults to the connecting MCP client)
    model?: string // the model behind the agent, e.g. claude-opus-4-8
    confidence?: number // 0..1
    reason?: string // the agent's justification
    parentItemId?: string // resubmit a sent-back item against this parent (CLE-140 revise loop)
  },
): Promise<ToolResult> {
  try {
    // Real provenance + proof case so the review card shows who proposed this,
    // on what model, with what confidence — not the 'agent'/'—'/'90%' defaults.
    const proof: Record<string, unknown> = {}
    if (typeof args.confidence === 'number') proof.confidence = args.confidence
    if (args.reason) proof.reason = args.reason
    const context: Record<string, unknown> = {}
    if (args.summary) context.summary = args.summary
    if (args.agentId) context.agent_id = args.agentId
    if (args.model) context.model = args.model
    if (Object.keys(proof).length > 0) context.proof = proof

    const r = await cb.gate({
      action: args.action,
      params: args.params ?? {},
      ...(args.policy ? { policy: args.policy } : {}),
      ...(args.parentItemId ? { parentItemId: args.parentItemId } : {}),
      ...(Object.keys(context).length > 0 ? { context } : {}),
    })
    if (r.shadow) {
      return { text: `Shadow mode — not blocking. Would have been: ${r.would?.verdict ?? 'n/a'}.`, structured: { cleared: true, shadow: true, result: r } }
    }
    if (r.status === 'cleared') {
      return { text: `✅ Cleared${hash8(r.attestation?.hash)}. Safe to proceed.`, structured: { cleared: true, result: r } }
    }
    if (r.status === 'rejected') {
      return { text: `⛔ Rejected${r.reason ? `: ${r.reason}` : ''}. Do NOT proceed.`, isError: false, structured: { cleared: false, reason: r.reason ?? null, result: r } }
    }
    if (r.status === 'sent_back') {
      return sentBackResult(r)
    }
    // pending → a human must decide. Sync-wait up to a configurable window
    // (CLEAREDBY_MCP_WAIT_MS, default 10 min). For long / out-of-hours waits
    // prefer a callback_url (park-and-resume) over holding this call open
    // (CLE-99) — the item stays open either way; only the wait differs.
    const waitMs = Number(process.env.CLEAREDBY_MCP_WAIT_MS) || 10 * 60_000
    let settled
    try {
      settled = await cb.wait(r.id, { timeoutMs: waitMs })
    } catch {
      // Timed out while still pending — NOT a rejection. The item stays open
      // for a human; surface that honestly rather than as a failure.
      return {
        text: `⏳ Still awaiting a human after ${Math.round(waitMs / 60000)} min — request ${r.id} stays open (not rejected). Re-check later, or pass a callback_url to be notified when it's decided.`,
        structured: { cleared: false, pending: true, id: r.id, result: r },
      }
    }
    if (settled.status === 'cleared') {
      return { text: `✅ Approved by a reviewer${hash8(settled.attestation?.hash)}. Safe to proceed.`, structured: { cleared: true, result: settled } }
    }
    if (settled.status === 'sent_back') {
      return sentBackResult(settled)
    }
    return { text: `⛔ Rejected by a reviewer${settled.reason ? `: ${settled.reason}` : ''}. Do NOT proceed.`, structured: { cleared: false, reason: settled.reason ?? null, result: settled } }
  } catch (err) {
    if (err instanceof RejectedError) {
      return { text: `⛔ Rejected: ${err.result.reason ?? 'no reason given'}. Do NOT proceed.`, structured: { cleared: false, result: err.result } }
    }
    return { text: `Clearance check failed: ${err instanceof Error ? err.message : 'unknown error'}`, isError: true, structured: { cleared: false } }
  }
}

/** check_policy: dry-run — what would the policy do, with nothing persisted. */
export async function checkPolicy(
  cb: ClearedBy,
  args: { action: string; params?: Record<string, unknown>; policy?: string },
): Promise<ToolResult> {
  try {
    const r = await cb.check({ action: args.action, params: args.params ?? {}, ...(args.policy ? { policy: args.policy } : {}) })
    return { text: `Dry run: would be **${r.verdict}** (rule: ${r.rule}). Nothing was recorded.`, structured: { ...r } }
  } catch (err) {
    return { text: `Policy check failed: ${err instanceof Error ? err.message : 'unknown error'}`, isError: true, structured: {} }
  }
}

/** get_ledger: recent signed attestations. */
export async function getLedger(cb: ClearedBy, args: { limit?: number }): Promise<ToolResult> {
  try {
    const r = await cb.ledger({ limit: args.limit ?? 20 })
    const n = Array.isArray(r.entries) ? r.entries.length : 0
    return { text: `${n} recent attestation${n === 1 ? '' : 's'} (newest first).`, structured: { ...r } }
  } catch (err) {
    return { text: `Ledger fetch failed: ${err instanceof Error ? err.message : 'unknown error'}`, isError: true, structured: {} }
  }
}
