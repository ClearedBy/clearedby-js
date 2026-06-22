// @clearedby/sdk (CLE-15) — a tiny, dependency-free client for the ClearedBy
// gate. Call gate() before a consequential agent action; the policy either
// clears it instantly, rejects it, or holds it for a human. wait() blocks
// until a held item resolves; guard() wraps a function so it only runs once
// cleared. Works anywhere fetch exists (Node 18+, edge, browser).

export type Verdict = 'auto' | 'review' | 'dual_review' | 'reject'
export type GateStatus = 'cleared' | 'rejected' | 'pending' | 'sent_back'

export interface ClearedByOptions {
  /** API key, e.g. `cb_live_…`. */
  apiKey: string
  /** Defaults to https://app.clearedby.com */
  baseUrl?: string
  /** Inject a fetch impl (tests / non-global-fetch runtimes). */
  fetch?: typeof fetch
}

export interface GateInput {
  action: string
  params?: Record<string, unknown>
  context?: Record<string, unknown>
  /** Named policy; omit to use the org default. */
  policy?: string
  mode?: 'enforce' | 'shadow'
  /** Webhook to resume on when held. */
  callbackUrl?: string
  /** Seconds, or a duration string like "1h". */
  timeout?: number | string
  /** Resubmit a sent-back item (CLE-140): the parent item id to link to. */
  parentItemId?: string
}

export interface GateResult {
  id: string
  status: GateStatus
  rule?: string
  sampled?: boolean
  /** shadow mode: what would have happened. */
  shadow?: boolean
  would?: { verdict: Verdict; rule: string }
  decided_by?: string
  expires_at?: string
  routed_to?: string[]
  attestation?: { seq: number; hash: string; signature?: string }
  resume?: { mode: 'poll' | 'webhook'; poll?: string; wait?: string; callback_url?: string }
  reason?: string | null
  /** Revise chain position (CLE-140): 1 = original, N = the Nth resubmission. */
  attempt?: number
  parent_item_id?: string | null
}

export class ClearedByError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly body?: unknown) {
    super(message)
    this.name = 'ClearedByError'
  }
}

/** Thrown by guard() when the policy (or a reviewer) rejects the action. */
export class RejectedError extends Error {
  constructor(readonly result: GateResult) {
    super(`Action rejected${result.reason ? `: ${result.reason}` : ''}`)
    this.name = 'RejectedError'
  }
}

/**
 * Thrown by guard() when a reviewer sends the action back to revise (CLE-140).
 * `reason` is the revision instruction; `result.id` is the parent to resubmit
 * against once you've regenerated. Catch it, regenerate, then call
 * `clearedby.resubmit(result.id, { ...revisedInput })`.
 */
export class SentBackError extends Error {
  readonly reason: string | null
  constructor(readonly result: GateResult) {
    super(`Action sent back to revise${result.reason ? `: ${result.reason}` : ''}`)
    this.name = 'SentBackError'
    this.reason = result.reason ?? null
  }
}

const DEFAULT_BASE = 'https://app.clearedby.com'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export class ClearedBy {
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch

  constructor(opts: ClearedByOptions) {
    if (!opts?.apiKey) throw new Error('ClearedBy: apiKey is required')
    this.apiKey = opts.apiKey
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/$/, '')
    const f = opts.fetch ?? (globalThis.fetch as typeof fetch | undefined)
    if (!f) throw new Error('ClearedBy: no fetch available — pass options.fetch')
    this.fetchImpl = f
  }

  private async call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    const json = await res.json().catch(() => ({}))
    return { status: res.status, json }
  }

  /** Gate an action. Returns the verdict (cleared / rejected / pending). */
  async gate(input: GateInput): Promise<GateResult> {
    const { status, json } = await this.call('POST', '/v1/gate', {
      action: input.action,
      params: input.params ?? {},
      context: input.context ?? {},
      ...(input.policy ? { policy: input.policy } : {}),
      ...(input.mode ? { mode: input.mode } : {}),
      ...(input.callbackUrl ? { callback_url: input.callbackUrl } : {}),
      ...(input.timeout !== undefined ? { timeout: input.timeout } : {}),
      ...(input.parentItemId ? { parent_item_id: input.parentItemId } : {}),
    })
    if (status !== 200 && status !== 202) {
      throw new ClearedByError(json?.error?.message ?? `gate failed (${status})`, status, json?.error?.code, json)
    }
    return json as GateResult
  }

  /**
   * Resubmit a sent-back item with revised params (CLE-140). Links the new
   * attempt to `parentItemId` so the whole revise chain is one auditable
   * lineage. Subject to the policy's revision cap — after the cap, the gate
   * forces a terminal verdict instead of holding for review again.
   */
  async resubmit(parentItemId: string, input: GateInput): Promise<GateResult> {
    return this.gate({ ...input, parentItemId })
  }

  /**
   * Dry-run a gate call (POST /v1/gate?dry=1): evaluate and return the verdict
   * WITHOUT persisting a work item or attestation. Use to preview what a policy
   * would do for an action+params.
   */
  async check(input: GateInput): Promise<{ dry: true; verdict: Verdict; rule: string; sampled: boolean }> {
    const { status, json } = await this.call('POST', '/v1/gate?dry=1', {
      action: input.action,
      params: input.params ?? {},
      context: input.context ?? {},
      ...(input.policy ? { policy: input.policy } : {}),
    })
    if (status !== 200) throw new ClearedByError(json?.error?.message ?? `check failed (${status})`, status, json?.error?.code, json)
    return json
  }

  /** Recent ledger (attestation) entries, newest first. */
  async ledger(opts: { limit?: number } = {}): Promise<{ entries: unknown[]; next_cursor?: string | null }> {
    const q = opts.limit ? `?limit=${opts.limit}` : ''
    const { status, json } = await this.call('GET', `/v1/ledger${q}`)
    if (status !== 200) throw new ClearedByError(json?.error?.message ?? `ledger failed (${status})`, status, json?.error?.code, json)
    return json
  }

  /**
   * Report proof of execution for a decided item (CLE-139). Records a
   * `completion` attestation: what status, what you actually executed (for the
   * authorized-vs-executed divergence check), and an optional verifiable
   * `externalRef` (e.g. a Stripe refund id) that earns the Tier-3 "verifiable"
   * label. This is NOT a verdict — it records execution, decides nothing.
   */
  async complete(
    id: string,
    input: {
      status: 'done' | 'failed' | 'partial'
      executedParams?: Record<string, unknown>
      externalRef?: string
      evidence?: { type: string; value: unknown }[]
      result?: unknown
    },
  ): Promise<{ recorded: boolean; tier: 1 | 2 | 3; diverged: boolean; status: string; seq?: number; hash?: string }> {
    const { status, json } = await this.call('POST', `/v1/gate/${encodeURIComponent(id)}/complete`, {
      status: input.status,
      ...(input.executedParams ? { executed_params: input.executedParams } : {}),
      ...(input.externalRef ? { external_ref: input.externalRef } : {}),
      ...(input.evidence ? { evidence: input.evidence } : {}),
      ...(input.result !== undefined ? { result: input.result } : {}),
    })
    if (status !== 200) throw new ClearedByError(json?.error?.message ?? `complete failed (${status})`, status, json?.error?.code, json)
    return json
  }

  /** Current state of a gated item. */
  async status(id: string): Promise<GateResult> {
    const { status, json } = await this.call('GET', `/v1/gate/${encodeURIComponent(id)}`)
    if (status !== 200) throw new ClearedByError(json?.error?.message ?? `status failed (${status})`, status, json?.error?.code, json)
    return json as GateResult
  }

  /**
   * Block until a held item reaches a terminal state (cleared / rejected /
   * sent_back) or the timeout elapses. A send-back is terminal for this attempt
   * — wait() returns it (with the reviewer's reason) rather than hanging, so the
   * caller can regenerate and resubmit (CLE-140).
   */
  async wait(id: string, opts: { timeoutMs?: number; pollMs?: number } = {}): Promise<GateResult> {
    const deadline = Date.now() + (opts.timeoutMs ?? 5 * 60_000)
    const pollMs = opts.pollMs ?? 2_000
    for (;;) {
      const cur = await this.status(id)
      if (cur.status === 'cleared' || cur.status === 'rejected' || cur.status === 'sent_back') return cur
      if (Date.now() >= deadline) throw new ClearedByError(`wait timed out for ${id}`, 408, 'timeout')
      await sleep(pollMs)
    }
  }

  /**
   * Gate `action`, and only run `fn` if it clears (now or after a human
   * approves). Throws RejectedError if rejected, SentBackError if a reviewer
   * sends it back to revise (catch it, regenerate, and call resubmit()),
   * ClearedByError on timeout. In shadow mode nothing blocks — `fn` always runs.
   */
  async guard<T>(input: GateInput, fn: () => Promise<T> | T): Promise<T> {
    const r = await this.gate(input)
    if (r.shadow) return await fn()
    if (r.status === 'cleared') return await fn()
    if (r.status === 'rejected') throw new RejectedError(r)
    if (r.status === 'sent_back') throw new SentBackError(r)
    const settled = await this.wait(r.id, { timeoutMs: 60 * 60_000 })
    if (settled.status === 'cleared') return await fn()
    if (settled.status === 'sent_back') throw new SentBackError(settled)
    throw new RejectedError(settled)
  }
}

export default ClearedBy
