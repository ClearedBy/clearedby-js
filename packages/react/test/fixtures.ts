import { vi } from 'vitest'
import type { Approval, Permissions, Rules } from '../src/types'

export const baseItem = (over: Partial<Approval> = {}): Approval => ({
  id: 'item_1',
  status: 'pending',
  action: 'shopify.refund.create',
  summary: 'Refund order #6001',
  params: { store: 'acme.myshopify.com', order_id: 'gid://shopify/Order/6001', amount: 18.5, currency: 'GBP', reason: 'Arrived damaged' },
  proof: { reason: 'Customer sent photos of the damage', confidence: 0.9 },
  evidence: { claims: [], verified: [] },
  batch_id: null,
  attempt: 1,
  parent_item_id: null,
  routed_to: [],
  escalation: null,
  dual_review: null,
  expires_at: null,
  verdict_source: null,
  decided_by: null,
  decided_at: null,
  reason: null,
  completion: null,
  created_at: new Date(Date.now() - 5 * 60_000).toISOString(),
  updated_at: new Date().toISOString(),
  ...over,
})

export const perms = (can: Permissions['can'], cannot: Permissions['cannot'] = []): Permissions => ({
  id: 'item_1',
  status: 'pending',
  reviewer: { user_id: 'u1', external_subject: 'alice', name: 'Alice' },
  can,
  cannot,
  requires_passkey: false,
  reason_required: ['reject', 'send_back'],
  dual_review: null,
})

export const rules = (over: Partial<Rules> = {}): Rules => ({
  settings: {
    tags_auto_max_products: 200,
    inventory_auto_max_items: 50,
    price_changes: 'always_review',
    price_drop_review_pct: 30,
    discounts: 'always_review',
    refund_auto_max: 25,
    refund_dual_above: 250,
    refund_daily_auto_cap: 250,
    refund_per_order_cap: 25,
    order_cancel: 'always_review',
    timeout_hours: 72,
    spot_checks: false,
    spot_check_pct: 5,
  },
  summary: [
    { key: 'refund_auto_max', action_label: 'Refunds', sentence: 'Refunds over £25 need your OK' },
    { key: 'refund_dual_above', action_label: 'Refunds', sentence: 'Refunds over £250 need two people to approve' },
  ],
  active_version: 2,
  currency: 'GBP',
  viewer: { role: 'owner', can_edit: true, can_accept: true },
  ...over,
})

export interface Recorded {
  method: string
  path: string
  body: any
}

type Route = (body: any, path: string) => { status?: number; body: unknown } | unknown

/**
 * A fake proxy. `routes` maps 'METHOD /path' (path may be a RegExp source,
 * query stripped) to a handler returning either `{status, body}` or a body.
 */
export function fakeProxy(routes: Record<string, Route>) {
  const calls: Recorded[] = []
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), 'http://app.test')
    const method = init?.method ?? 'GET'
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body))
    const path = url.pathname.replace(/^\/api\/clearedby/, '')
    calls.push({ method, path: `${path}${url.search}`, body })
    const hit = Object.entries(routes).find(([k]) => new RegExp(`^${k}$`).test(`${method} ${path}`))
    if (hit === undefined) return new Response(JSON.stringify({ error: { code: 'not_found', message: 'no route' } }), { status: 404 })
    const out = hit[1](body, path) as { status?: number; body?: unknown }
    const wrapped = out !== null && typeof out === 'object' && 'body' in out && Object.keys(out).every((k) => k === 'status' || k === 'body')
    const status = wrapped ? out.status ?? 200 : 200
    return new Response(JSON.stringify(wrapped ? out.body : out), { status, headers: { 'content-type': 'application/json' } })
  })
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls }
}
