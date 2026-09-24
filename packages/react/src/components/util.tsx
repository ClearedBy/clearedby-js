import { useMemo, type ButtonHTMLAttributes } from 'react'
import { useClearedBy } from '../context'
import { makeFormatters, type Formatters } from '../describe'
import type { Labels } from '../labels'
import type { ItemStatus } from '../types'
import type { BadgeTone, Slot, Ui } from '../ui'

export function useFormatters(): Formatters {
  const { locale } = useClearedBy()
  return useMemo(() => makeFormatters(locale), [locale])
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
]

/** '5 minutes ago' / 'in 2 hours'. */
export function relativeTime(iso: string, locale?: string, now = Date.now()): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const diff = Math.round((t - now) / 1000)
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  for (const [unit, secs] of UNITS) {
    if (Math.abs(diff) >= secs) return rtf.format(Math.round(diff / secs), unit)
  }
  return rtf.format(0, 'minute')
}

export function absoluteTime(iso: string, locale?: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(t))
}

const TONE: Record<ItemStatus, BadgeTone> = {
  pending: 'waiting',
  escalated: 'waiting',
  cleared: 'ok',
  rejected: 'bad',
  expired: 'muted',
  sent_back: 'warn',
  revoked: 'muted',
  withdrawn: 'muted',
}

const TONE_SLOT: Record<BadgeTone, Slot> = {
  waiting: 'badgeWaiting',
  ok: 'badgeOk',
  bad: 'badgeBad',
  warn: 'badgeWarn',
  muted: 'badgeMuted',
}

export function StatusBadge({ status, labels, ui }: { status: ItemStatus; labels: Labels; ui: Ui }) {
  const tone = TONE[status] ?? 'muted'
  return <ui.C.Badge tone={tone} className={ui.cls('badge', TONE_SLOT[tone])}>{labels.status[status] ?? status}</ui.C.Badge>
}

/** Friendly text for an error from a hook. */
export function errorText(err: unknown, labels: Labels, fallback: string = labels.loadError): string {
  const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : ''
  if (code === 'reason_required') return labels.reasonTooShort
  if (code !== '' && labels.cannot[code] !== undefined) return labels.cannot[code] as string
  return fallback
}

/** A button with the right slot classes for its variant, via the (maybe injected) Button. */
export function Btn({ ui, variant, ...rest }: { ui: Ui; variant: 'primary' | 'secondary' | 'danger' | 'ghost' } & ButtonHTMLAttributes<HTMLButtonElement>) {
  const slot: Slot = variant === 'primary' ? 'primaryButton' : variant === 'danger' ? 'dangerButton' : variant === 'ghost' ? 'ghostButton' : 'secondaryButton'
  return <ui.C.Button type="button" variant={variant} {...rest} className={ui.cls('button', slot)} />
}
