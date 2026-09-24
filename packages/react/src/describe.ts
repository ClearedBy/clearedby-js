// Turn an action + its params into plain English, and a batch into before/after
// rows. Knows the Shopify catalogue (shopify.*); anything else falls back to the
// agent's own one-line summary, then to a tidied-up action name.

import type { Approval } from './types'

/** Catalogue titles (the same names the Shopify action catalogue uses). */
export const ACTION_TITLES: Record<string, string> = {
  'shopify.product.update': 'Update products',
  'shopify.product.tags.update': 'Update product tags',
  'shopify.price.update': 'Update prices',
  'shopify.inventory.set': 'Set inventory',
  'shopify.discount.create': 'Create a discount',
  'shopify.discount.disable': 'Disable a discount',
  'shopify.refund.create': 'Refund an order',
  'shopify.order.cancel': 'Cancel an order',
}

const CANCEL_REASONS: Record<string, string> = {
  customer: 'the customer asked',
  declined: 'the payment was declined',
  fraud: 'it looks like fraud',
  inventory: 'items are out of stock',
  staff: 'a staff error',
  other: 'another reason',
}

export interface Formatters {
  money: (amount: number | string, currency?: string) => string
  number: (n: number) => string
}

export function makeFormatters(locale?: string): Formatters {
  return {
    money: (amount, currency) => {
      const n = typeof amount === 'string' ? Number(amount) : amount
      if (!Number.isFinite(n)) return String(amount)
      if (currency === undefined || !/^[A-Z]{3}$/.test(currency)) return n.toLocaleString(locale)
      try {
        return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(n)
      } catch {
        return `${n.toLocaleString(locale)} ${currency}`
      }
    },
    number: (n) => n.toLocaleString(locale),
  }
}

/** 'gid://shopify/Order/6001' → '#6001'; anything else unchanged. */
export function shortId(v: unknown): string {
  if (typeof v !== 'string') return String(v ?? '')
  const m = /^gid:\/\/shopify\/[A-Za-z]+\/(\d+)$/.exec(v)
  return m ? `#${m[1]}` : v
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

function batchCount(p: Record<string, unknown>): number {
  return num(p.count) ?? (Array.isArray(p.changes) ? p.changes.length : 0)
}

const plural = (n: number, one: string, many: string, f: Formatters): string => `${f.number(n)} ${n === 1 ? one : many}`

/** 'refund.create' → 'Refund create'. */
export function humanizeAction(action: string): string {
  const words = action.replace(/^shopify\./, '').split(/[._-]+/).filter(Boolean)
  const s = words.join(' ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** Humanize a params key: 'order_id' → 'Order', 'notify_customer' → 'Notify customer'. */
export function humanizeKey(key: string): string {
  const s = key.replace(/_id$/, '').replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** A one-line, plain-English description of what the assistant wants to do. */
export function describeAction(item: Pick<Approval, 'action' | 'params' | 'summary'>, f: Formatters): { title: string; sentence: string } {
  const p = item.params ?? {}
  const title = ACTION_TITLES[item.action] ?? humanizeAction(item.action)
  const fallback = item.summary ?? title
  let sentence: string | undefined
  switch (item.action) {
    case 'shopify.refund.create': {
      const amount = num(p.amount)
      sentence = amount !== undefined
        ? `Refund ${f.money(amount, str(p.currency))} on order ${shortId(p.order_id)}`
        : `Refund order ${shortId(p.order_id)}`
      break
    }
    case 'shopify.order.cancel': {
      const why = CANCEL_REASONS[String(p.reason)]
      sentence = `Cancel order ${shortId(p.order_id)}${why ? ` because ${why}` : ''}${p.refund === true ? ', with a refund' : ''}`
      break
    }
    case 'shopify.price.update':
      sentence = `Change prices on ${plural(batchCount(p), 'product', 'products', f)}`
      if (num(p.max_drop_pct) !== undefined && (p.max_drop_pct as number) > 0) sentence += ` (biggest drop ${Math.round(p.max_drop_pct as number)}%)`
      break
    case 'shopify.product.tags.update':
      sentence = `Change tags on ${plural(batchCount(p), 'product', 'products', f)}`
      break
    case 'shopify.product.update':
      sentence = `Update ${plural(batchCount(p), 'product', 'products', f)}`
      break
    case 'shopify.inventory.set':
      sentence = `Update stock for ${plural(batchCount(p), 'item', 'items', f)}`
      break
    case 'shopify.discount.create': {
      const value = num(p.value)
      const off = value === undefined ? '' : p.value_type === 'percentage' ? `${value}% off` : `${f.money(value, str(p.currency))} off`
      const name = str(p.code) ?? str(p.title)
      sentence = `Create ${name ? `the discount ${name}` : 'a discount'}${off ? `: ${off}` : ''}`
      break
    }
    case 'shopify.discount.disable':
      sentence = `Turn off the discount ${str(p.code) ?? str(p.label) ?? shortId(p.discount_id)}`
      break
    default:
      sentence = undefined
  }
  return { title, sentence: sentence ?? fallback }
}

export interface ChangeRow {
  key: string
  item: string
  before: string
  after: string
}

const fmtTags = (v: unknown): string => (Array.isArray(v) ? (v.length === 0 ? '(none)' : v.join(', ')) : String(v ?? ''))
const fmtValue = (v: unknown): string => {
  if (v === null || v === undefined) return '(empty)'
  if (typeof v === 'string') return v.length > 200 ? `${v.slice(0, 200)}…` : v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return v.map(fmtValue).join(', ')
  return JSON.stringify(v)
}

/**
 * Before/after rows for a batch (`params.changes[]`). Computed lazily page by
 * page by the table, so a 3,000-item batch costs nothing until it's viewed.
 */
export function isBatch(item: Pick<Approval, 'params'>): boolean {
  return Array.isArray(item.params?.changes)
}

export function changeRowsFor(item: Pick<Approval, 'action' | 'params'>, f: Formatters, from: number, to: number): ChangeRow[] {
  const p = item.params ?? {}
  const changes = Array.isArray(p.changes) ? (p.changes as Array<Record<string, unknown>>) : []
  const currency = str(p.currency)
  const rows: ChangeRow[] = []
  for (let i = from; i < Math.min(to, changes.length); i++) {
    const c = changes[i] ?? {}
    const name = str(c.label) ?? shortId(c.product_id ?? c.variant_id ?? c.inventory_item_id ?? `Item ${i + 1}`)
    if (item.action === 'shopify.price.update') {
      const b = (c.before ?? {}) as Record<string, unknown>
      const a = (c.after ?? {}) as Record<string, unknown>
      const was = (x: Record<string, unknown>) =>
        `${f.money(String(x.price ?? ''), currency)}${str(x.compare_at_price) ? ` (was ${f.money(String(x.compare_at_price), currency)})` : ''}`
      rows.push({ key: `${i}`, item: name, before: was(b), after: was(a) })
    } else if (item.action === 'shopify.product.tags.update') {
      rows.push({ key: `${i}`, item: name, before: fmtTags(c.before), after: fmtTags(c.after) })
    } else if (item.action === 'shopify.product.update' && c.fields && typeof c.fields === 'object') {
      for (const [field, ch] of Object.entries(c.fields as Record<string, { before?: unknown; after?: unknown }>)) {
        rows.push({ key: `${i}.${field}`, item: `${name} · ${humanizeKey(field)}`, before: fmtValue(ch?.before), after: fmtValue(ch?.after) })
      }
    } else {
      rows.push({ key: `${i}`, item: name, before: fmtValue(c.before), after: fmtValue(c.after) })
    }
  }
  return rows
}

/** A one-line overview shown above a batch table. */
export function batchSummary(item: Pick<Approval, 'action' | 'params'>, f: Formatters): string[] {
  const p = item.params ?? {}
  const changes = Array.isArray(p.changes) ? (p.changes as Array<Record<string, unknown>>) : []
  const out: string[] = []
  if (item.action === 'shopify.price.update') {
    let up = 0
    let down = 0
    for (const c of changes) {
      const b = Number((c.before as Record<string, unknown> | undefined)?.price)
      const a = Number((c.after as Record<string, unknown> | undefined)?.price)
      if (a > b) up++
      else if (a < b) down++
    }
    if (down > 0) out.push(`${f.number(down)} cheaper`)
    if (up > 0) out.push(`${f.number(up)} more expensive`)
    if (num(p.max_drop_pct) !== undefined && (p.max_drop_pct as number) > 0) out.push(`biggest drop ${Math.round(p.max_drop_pct as number)}%`)
  } else if (item.action === 'shopify.inventory.set') {
    let delta = 0
    for (const c of changes) delta += (num(c.after) ?? 0) - (num(c.before) ?? 0)
    out.push(`${delta >= 0 ? '+' : '−'}${f.number(Math.abs(delta))} in total`)
  } else if (item.action === 'shopify.product.tags.update') {
    const added = new Map<string, number>()
    const removed = new Map<string, number>()
    for (const c of changes) {
      const b = new Set(Array.isArray(c.before) ? (c.before as string[]) : [])
      const a = new Set(Array.isArray(c.after) ? (c.after as string[]) : [])
      for (const t of a) if (!b.has(t)) added.set(t, (added.get(t) ?? 0) + 1)
      for (const t of b) if (!a.has(t)) removed.set(t, (removed.get(t) ?? 0) + 1)
    }
    const top = (m: Map<string, number>) => [...m.entries()].sort((x, y) => y[1] - x[1]).slice(0, 3).map(([t]) => `“${t}”`).join(', ')
    if (added.size > 0) out.push(`adds ${top(added)}`)
    if (removed.size > 0) out.push(`removes ${top(removed)}`)
  }
  return out
}

function humanWindow(seconds: number): string {
  if (seconds % 86400 === 0) return seconds === 86400 ? '24 hours' : `${seconds / 86400} days`
  if (seconds % 3600 === 0) return seconds === 3600 ? 'hour' : `${seconds / 3600} hours`
  return `${Math.round(seconds / 60)} minutes`
}

/**
 * The automatically-checked facts in plain words. Their stored labels are
 * written for developers, so the known ones are re-phrased here; an unknown
 * one falls back to its type name. Returns null for a non-object value.
 */
export function computedEvidenceText(
  e: { type: string; value: unknown },
  f: Formatters,
  currency?: string,
): { label: string; text: string } | null {
  const v = e.value as Record<string, unknown> | null
  if (v === null || typeof v !== 'object') return null
  switch (e.type) {
    case 'catalogue_count':
      return num(v.count) === undefined ? null : { label: 'Items in this change', text: f.number(v.count as number) }
    case 'max_drop_pct':
      return num(v.max_drop_pct) === undefined ? null : { label: 'Largest price drop', text: `${Math.round(v.max_drop_pct as number)}%` }
    case 'currency': {
      const amount = num(v.amount)
      const cur = str(v.currency)
      const text = amount !== undefined ? f.money(amount, cur) : cur ?? ''
      return {
        label: 'Amount',
        text: v.matches_policy_currency === false
          ? `${text} — a different currency from your rules, so a person needs to check it`
          : text,
      }
    }
    case 'aggregate': {
      const prior = num(v.prior)
      const incl = num(v.including_this_request)
      const secs = num(v.window_seconds)
      if (prior === undefined || incl === undefined || secs === undefined) return null
      const by = str(v.by)
      const scope = by ? ` on this ${humanizeKey(by.split('.').at(-1) ?? by).toLowerCase()}` : ''
      const isSum = v.fn === 'sum'
      const field = str(v.field) ?? ''
      const isMoney = isSum && /amount|total|price|refund/.test(field)
      const show = (n: number) => (isMoney ? f.money(n, currency) : f.number(n))
      const what = isSum
        ? `${isMoney || field === '' ? 'Total' : humanizeKey(field.split('.').at(-1) ?? field)} in the last ${humanWindow(secs)}${scope}`
        : `How many in the last ${humanWindow(secs)}${scope}`
      return { label: what, text: `${show(incl)} including this one (${show(prior)} before)` }
    }
    default:
      return null
  }
}

/** Plain key/value details for a single (non-batch) action. Skips ids the merchant doesn't need. */
export function detailRows(item: Pick<Approval, 'action' | 'params'>, f: Formatters): { label: string; value: string }[] {
  const p = item.params ?? {}
  const rows: { label: string; value: string }[] = []
  for (const [k, v] of Object.entries(p)) {
    if (k === 'store' || k === 'changes' || k === 'count' || k === 'max_drop_pct' || k === 'currency') continue
    if (v === undefined || v === null || (typeof v === 'object' && !Array.isArray(v))) continue
    let value: string
    if (k === 'amount' && typeof v === 'number') value = f.money(v, str(p.currency))
    else if (typeof v === 'boolean') value = v ? 'Yes' : 'No'
    else if (Array.isArray(v)) value = `${f.number(v.length)} ${v.length === 1 ? 'item' : 'items'}`
    else value = shortId(v)
    rows.push({ label: humanizeKey(k), value })
  }
  return rows
}
