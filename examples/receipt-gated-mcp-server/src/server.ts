/**
 * "Partner Billing" — a THIRD-PARTY MCP server that does not trust ClearedBy.
 *
 * This file is the whole point of the receipt protocol (CLE-203): note what it
 * imports. `@clearedby/sdk/receipt` — the offline verifier — and nothing else
 * from ClearedBy. No API key. No ClearedBy client. No network call at decision
 * time. The server holds ClearedBy's PUBLISHED public keys (fetched once,
 * cached) and decides entirely locally:
 *
 *   give me the receipt → I verify it here → if it authorizes THIS exact
 *   action, for THIS audience (me), and hasn't expired → I execute → I hand
 *   back execution proof.
 *
 * Three enforcement layers, each demonstrated:
 *   1. verifyReceipt() — signature, freshness, audience + action binding.
 *      Any tampering (amount, target, expiry, agent) reads as bad_signature.
 *   2. Nonce replay — a receipt is single-use here: seen nonces are refused
 *      for the TTL window. (The verifier documents this as the relying
 *      party's job; this is what it looks like.)
 *   3. Local constraints — the partner's OWN ceiling (MAX_REFUND) applied to
 *      the SIGNED params. Execution derives from receipt.params, never from
 *      caller-supplied arguments — there deliberately aren't any.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { verifyReceipt, type ReceiptKeys } from '@clearedby/sdk/receipt'

export interface PartnerServerOptions {
  /** This server's identity — receipts must name exactly this audience. */
  audience: string
  /** ClearedBy's published keys (key_id → raw public hex), or a resolver. */
  keys: ReceiptKeys
  /** The partner's own refund ceiling in major units (default 500). */
  maxRefund?: number
  /** Clock override for tests/demos. */
  now?: () => Date
}

/** Executed refunds, in memory — what "execution" means for this demo. */
export interface ExecutedRefund {
  external_ref: string
  amount: number
  currency: string
  order: string
  receipt_id: string
  executed_at: string
}

export function buildPartnerServer(opts: PartnerServerOptions): {
  server: McpServer
  executed: ExecutedRefund[]
} {
  const maxRefund = opts.maxRefund ?? 500
  const executed: ExecutedRefund[] = []
  // Nonce replay guard: a receipt authorizes ONE execution here. Entries can
  // be dropped once the receipt they belong to has expired (plus skew).
  const seenNonces = new Map<string, number>() // nonce → expires_at ms

  const server = new McpServer({ name: 'partner-billing', version: '0.0.1' })

  const refuse = (reason: string) => ({
    isError: true as const,
    content: [{ type: 'text' as const, text: `REFUSED: ${reason}` }],
  })

  server.tool(
    'issue_refund',
    'Execute a refund — ONLY with a valid ClearedBy Authorization Receipt naming this server as the audience. ' +
      'The refund executes exactly per the signed params in the receipt; there are no other arguments to pass.',
    {
      receipt: z
        .record(z.unknown())
        .describe('the signed Authorization Receipt from the ClearedBy gate response (r.receipt)'),
    },
    async ({ receipt }) => {
      // Layer 1 — offline verification: signature, freshness, audience, action.
      const v = verifyReceipt(receipt, {
        keys: opts.keys,
        audience: opts.audience,
        action: 'refund.create',
        now: opts.now?.(),
      })
      if (!v.valid) return refuse(v.reason)

      // Layer 2 — replay: this nonce authorizes one execution, ever.
      const nowMs = (opts.now?.() ?? new Date()).getTime()
      for (const [nonce, exp] of seenNonces) if (exp < nowMs) seenNonces.delete(nonce)
      if (seenNonces.has(v.receipt.nonce)) return refuse('replayed nonce — this receipt was already used')
      seenNonces.set(v.receipt.nonce, Date.parse(v.receipt.expires_at) + 60_000)

      // Layer 3 — the partner's own constraints, applied to the SIGNED params.
      const amount = v.receipt.params.amount
      const currency = v.receipt.params.currency
      const order = v.receipt.params.order ?? v.receipt.params.orderId
      if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
        return refuse('signed params carry no positive amount')
      }
      if (amount > maxRefund) return refuse(`amount ${amount} exceeds this partner's ceiling of ${maxRefund}`)
      if (typeof order !== 'string' || order === '') return refuse('signed params carry no order reference')

      // Execute — from the signed statement, nothing else.
      const record: ExecutedRefund = {
        external_ref: 'rf_' + v.receipt.nonce.slice(0, 12),
        amount,
        currency: typeof currency === 'string' ? currency : 'GBP',
        order,
        receipt_id: v.receipt.receipt_id,
        executed_at: new Date(nowMs).toISOString(),
      }
      executed.push(record)
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ executed: true, ...record }),
          },
        ],
      }
    },
  )

  return { server, executed }
}
