import { useClearedBy, useLabels, useUi } from '../context'
import { useHistory } from '../hooks'
import type { LabelOverrides } from '../labels'
import type { HistoryEvent } from '../types'
import type { StyleProps } from '../ui'
import { absoluteTime, relativeTime } from './util'

export interface HistoryProps extends StyleProps {
  id: string
  labels?: LabelOverrides
  /** Heading text; `false` hides it. */
  title?: string | false
}

/**
 * The item's story, oldest first: asked, sent back and revised, approved,
 * carried out, cancelled or undone. Technical steps are left out.
 */
export function History({ id, labels: overrides, title, ...style }: HistoryProps) {
  const labels = useLabels(overrides)
  const ui = useUi(style)
  const { locale } = useClearedBy()
  const h = useHistory(id)

  const rows: { e: HistoryEvent; text: string; newAttempt: boolean }[] = []
  let lastItem: string | null = null
  for (const e of h.data ?? []) {
    const text = labels.event(e.kind, (e.data ?? {}) as Record<string, unknown>)
    if (text === null) continue
    rows.push({ e, text, newAttempt: lastItem !== null && e.work_item_id !== lastItem })
    lastItem = e.work_item_id
  }

  const who = (e: HistoryEvent): string | null => {
    if (e.actor === null) return null
    if (e.actor.type === 'user') return e.actor.name ?? labels.someone
    if (e.actor.type === 'policy' || e.actor.type === 'system') return labels.automatic
    return null
  }

  return (
    <section className={ui.root()} aria-label={title === false ? labels.historyTitle : undefined}>
      {title === false ? null : <h3 className={ui.cls('subheading')}>{title ?? labels.historyTitle}</h3>}
      {h.data === undefined && h.error === undefined ? <p role="status" className={ui.cls('status')}>{labels.loading}</p> : null}
      {h.error !== undefined && h.data === undefined ? <p role="alert" className={ui.cls('error')}>{labels.loadError}</p> : null}
      {h.data !== undefined && rows.length === 0 ? <p className={ui.cls('status')}>{labels.historyEmpty}</p> : null}
      {rows.length > 0 ? (
        <ol className={ui.cls('timeline')}>
          {rows.map(({ e, text, newAttempt }) => {
            const by = who(e)
            const target = e.kind === 'escalated' && e.target ? e.target.name : null
            return (
              <li key={e.id} className={ui.cls('timelineItem', newAttempt && 'timelineRevision')} data-kind={e.kind}>
                <span>
                  {text}
                  {target ? ` → ${target}` : ''}
                  {by ? <span className={ui.cls('hint')}> · {by}</span> : null}
                </span>
                <time className={ui.cls('timelineTime')} dateTime={e.at} title={absoluteTime(e.at, locale)}>{relativeTime(e.at, locale)}</time>
              </li>
            )
          })}
        </ol>
      ) : null}
    </section>
  )
}
