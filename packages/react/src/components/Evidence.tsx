import type { ReactNode } from 'react'
import { useLabels, useUi } from '../context'
import { computedEvidenceText, humanizeKey } from '../describe'
import { useFormatters } from './util'
import type { LabelOverrides } from '../labels'
import type { EvidenceItem } from '../types'
import type { Slot, StyleProps, Ui } from '../ui'

export interface EvidenceGroup {
  key: string
  /** 'verified' (your backend), 'computed' (checked automatically), 'agent' (unchecked claims). */
  kind: 'verified' | 'computed' | 'agent'
  badge: string
  items: EvidenceItem[]
}

/**
 * Group evidence by who vouches for it: facts your backend verified (one group
 * per verifier), facts checked automatically, then what the agent claims.
 * Never trusts an agent claim's own `value` to decide how it is shown.
 */
export function groupEvidence(evidence: { claims: EvidenceItem[]; verified: EvidenceItem[] } | undefined, labels: {
  evidenceAgent: string
  evidenceVerifiedBy: (name: string) => string
  evidenceComputed: string
}): EvidenceGroup[] {
  if (evidence === undefined) return []
  const groups: EvidenceGroup[] = []
  const byVerifier = new Map<string, EvidenceItem[]>()
  const computed: EvidenceItem[] = []
  for (const e of evidence.verified ?? []) {
    if (e.provenance === 'partner_verified') {
      const name = e.verifier_name ?? 'your team'
      byVerifier.set(name, [...(byVerifier.get(name) ?? []), e])
    } else if (e.provenance === 'clearedby_computed') {
      computed.push(e)
    }
  }
  for (const [name, items] of byVerifier) groups.push({ key: `v:${name}`, kind: 'verified', badge: labels.evidenceVerifiedBy(name), items })
  if (computed.length > 0) groups.push({ key: 'computed', kind: 'computed', badge: labels.evidenceComputed, items: computed })
  // Anything that is not verified — whatever it claims about itself — is the agent's word.
  const claims = [
    ...(evidence.claims ?? []),
    ...(evidence.verified ?? []).filter((e) => e.provenance !== 'partner_verified' && e.provenance !== 'clearedby_computed'),
  ]
  if (claims.length > 0) groups.push({ key: 'agent', kind: 'agent', badge: labels.evidenceAgent, items: claims })
  return groups
}

const safeUrl = (u: unknown): string | null => (typeof u === 'string' && /^https:\/\//i.test(u) ? u : null)
const safeImage = (u: unknown): string | null =>
  typeof u === 'string' && (/^https:\/\//i.test(u) || /^data:image\/(png|jpe?g|gif|webp);base64,/i.test(u)) ? u : null

function Scalar({ v }: { v: unknown }) {
  if (v === null || v === undefined) return <>—</>
  if (typeof v === 'boolean') return <>{v ? 'Yes' : 'No'}</>
  if (typeof v === 'string' || typeof v === 'number') return <>{String(v)}</>
  return <>{JSON.stringify(v)}</>
}

function KV({ ui, rows }: { ui: Ui; rows: [string, unknown][] }) {
  return (
    <dl className={ui.cls('kv')}>
      {rows.map(([k, v], i) => (
        <div key={`${k}:${i}`} className={ui.cls('kvRow')}>
          <dt className={ui.cls('kvTerm')}>{k}</dt>
          <dd className={ui.cls('kvValue')}><Scalar v={v} /></dd>
        </div>
      ))}
    </dl>
  )
}

/** Render one evidence value in a friendly way (known shapes), else as a key/value list. */
function EvidenceValue({ item, ui }: { item: EvidenceItem; ui: Ui }): ReactNode {
  const v = item.value as any
  const text = ui.cls('evidenceValue')
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return <p className={text}><Scalar v={v} /></p>
  if (v === null || v === undefined) return null
  switch (item.type) {
    case 'threshold':
      if (typeof v.value === 'number') {
        return (
          <p className={text}>
            {v.label ? `${v.label}: ` : ''}{v.value}{v.unit ? ` ${v.unit}` : ''}
            {typeof v.limit === 'number' ? ` (limit ${v.limit}${v.unit ? ` ${v.unit}` : ''})` : ''}
          </p>
        )
      }
      break
    case 'entity':
      if (typeof v.name === 'string') {
        return (
          <div className={text}>
            <p className={ui.cls('text')}><strong>{v.name}</strong>{v.subtitle ? ` · ${v.subtitle}` : ''}</p>
            {Array.isArray(v.fields) ? <KV ui={ui} rows={v.fields.slice(0, 20).map((fld: any) => [String(fld?.label ?? ''), fld?.value])} /> : null}
          </div>
        )
      }
      break
    case 'table':
      if (Array.isArray(v.columns) && Array.isArray(v.rows)) {
        return (
          <div className={ui.cls('tableWrap')}>
            <table className={ui.cls('table')}>
              <thead><tr className={ui.cls('tableRow')}>{v.columns.map((c: unknown, i: number) => <th key={i} scope="col" className={ui.cls('tableHeadCell')}>{String(c)}</th>)}</tr></thead>
              <tbody>
                {v.rows.slice(0, 50).map((r: unknown[], i: number) => (
                  <tr key={i} className={ui.cls('tableRow')}>{(Array.isArray(r) ? r : []).map((c, j) => <td key={j} className={ui.cls('tableCell')}><Scalar v={c} /></td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      }
      break
    case 'timeline':
      if (Array.isArray(v)) {
        return (
          <ol className={ui.cls('evidenceValue', 'evidenceList')}>
            {v.slice(0, 50).map((e: any, i: number) => <li key={i}>{String(e?.label ?? '')}{e?.detail ? ` · ${e.detail}` : ''}</li>)}
          </ol>
        )
      }
      break
    case 'conversation':
      if (Array.isArray(v.messages)) {
        return (
          <ol className={ui.cls('evidenceValue', 'evidenceList')}>
            {v.messages.slice(0, 50).map((m: any, i: number) => (
              <li key={i}><strong>{String(m?.from ?? '')}</strong>{m?.from ? ': ' : ''}{String(m?.text ?? '')}</li>
            ))}
          </ol>
        )
      }
      break
    case 'source': {
      const href = safeUrl(v.url)
      return (
        <p className={text}>
          {href ? <a href={href} target="_blank" rel="noopener noreferrer" className={ui.cls('link')}>{String(v.title ?? href)}</a> : String(v.title ?? '')}
          {v.snippet ? <><br />{String(v.snippet)}</> : null}
        </p>
      )
    }
    case 'media': {
      const src = safeImage(v.url ?? v.dataUrl)
      return src ? <img className={text} src={src} alt={String(v.caption ?? item.label ?? '')} /> : null
    }
    default:
      break
  }
  if (Array.isArray(v)) return <p className={text}>{v.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(', ')}</p>
  return <KV ui={ui} rows={Object.entries(v as Record<string, unknown>).slice(0, 30).map(([k, val]) => [humanizeKey(k), val])} />
}

export interface EvidenceListProps extends StyleProps {
  evidence: { claims: EvidenceItem[]; verified: EvidenceItem[] } | undefined
  labels?: LabelOverrides
  /** The item's currency, for money figures in automatic checks. */
  currency?: string
}

const KIND_SLOT: Record<EvidenceGroup['kind'], Slot> = {
  verified: 'evidenceVerified',
  computed: 'evidenceComputed',
  agent: 'evidenceAgent',
}

/** Evidence grouped and badged by who vouches for it. */
export function EvidenceList({ evidence, labels: overrides, currency, ...style }: EvidenceListProps) {
  const labels = useLabels(overrides)
  const ui = useUi(style)
  const f = useFormatters()
  const groups = groupEvidence(evidence, labels)
  if (groups.length === 0) return null
  return (
    <div className={[ui.cls('evidence'), style.className].filter(Boolean).join(' ') || undefined}>
      {groups.map((g) => (
        <section key={g.key} className={ui.cls('evidenceGroup', KIND_SLOT[g.kind])} aria-label={g.badge} data-kind={g.kind}>
          <h4 className={ui.cls('subheading')}>
            <ui.C.Badge tone={g.kind === 'verified' ? 'ok' : g.kind === 'computed' ? 'waiting' : 'muted'} className={ui.cls('evidenceBadge')}>{g.badge}</ui.C.Badge>
          </h4>
          {g.kind === 'agent' ? <p className={ui.cls('hint')}>{labels.evidenceAgentHint}</p> : null}
          <ul className={ui.cls('list')}>
            {g.items.map((e, i) => {
              // Automatic checks are re-phrased for merchants (their stored labels are technical).
              const auto = e.provenance === 'clearedby_computed' ? computedEvidenceText(e, f, currency) : null
              const label = e.provenance === 'clearedby_computed' ? auto?.label ?? humanizeKey(e.type) : e.label ?? humanizeKey(e.type)
              return (
                <li key={e.id ?? `${g.key}:${i}`} className={ui.cls('evidenceItem')} data-provenance={e.provenance}>
                  <div className={ui.cls('evidenceLabel')}>{label}</div>
                  {e.integrity === 'mismatch' ? <p role="alert" className={ui.cls('warning')}>{labels.evidenceChanged}</p> : null}
                  {auto !== null ? <p className={ui.cls('evidenceValue')}>{auto.text}</p> : <EvidenceValue item={e} ui={ui} />}
                </li>
              )
            })}
          </ul>
        </section>
      ))}
    </div>
  )
}
