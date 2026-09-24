import { useRef, type KeyboardEvent, type ReactNode } from 'react'
import { useLabels, useUi } from '../context'
import { useApprovalQueue, type QueueOptions } from '../hooks'
import type { LabelOverrides } from '../labels'
import type { Approval } from '../types'
import { useDomId, type StyleProps } from '../ui'
import { ApprovalCard } from './ApprovalCard'
import { Btn } from './util'

export interface ApprovalQueueProps extends QueueOptions, StyleProps {
  /** Called when a card is chosen (click, Enter or Space). */
  onSelect?: (item: Approval) => void
  selectedId?: string | null
  /** Heading text; `false` hides it. */
  title?: ReactNode | false
  labels?: LabelOverrides
  /** Render your own card instead of <ApprovalCard>. */
  renderItem?: (item: Approval, selected: boolean) => ReactNode
}

/**
 * The reviewer's list of things waiting for them. Up/Down arrows move between
 * cards; Enter or Space opens one.
 */
export function ApprovalQueue(props: ApprovalQueueProps) {
  const { onSelect, selectedId, title, labels: overrides, renderItem, className, classNames, unstyled, ...queueOpts } = props
  const labels = useLabels(overrides)
  const ui = useUi({ className, classNames, unstyled })
  const q = useApprovalQueue(queueOpts)
  const headingId = useDomId('cbq')
  const listRef = useRef<HTMLUListElement>(null)

  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return
    const buttons = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-cb-card]') ?? [])
    if (buttons.length === 0) return
    const at = buttons.indexOf(document.activeElement as HTMLElement)
    const next = e.key === 'Home' ? 0
      : e.key === 'End' ? buttons.length - 1
        : e.key === 'ArrowDown' ? Math.min(buttons.length - 1, at + 1)
          : Math.max(0, at - 1)
    buttons[next]?.focus()
    e.preventDefault()
  }

  return (
    <section className={ui.root()} aria-labelledby={title === false ? undefined : headingId} aria-busy={q.loading}>
      {title === false ? null : <h2 id={headingId} className={ui.cls('heading')}>{title ?? labels.queueTitle}</h2>}
      {q.loading ? <p role="status" className={ui.cls('status')}>{labels.loading}</p> : null}
      {q.error !== undefined && q.items.length === 0 ? (
        <div role="alert" className={ui.cls('error')}>
          {labels.loadError}{' '}
          <button type="button" className={ui.cls('link')} onClick={() => void q.revalidate()}>{labels.retry}</button>
        </div>
      ) : null}
      {!q.loading && q.error === undefined && q.items.length === 0 ? <p className={ui.cls('status')}>{labels.queueEmpty}</p> : null}
      {q.items.length > 0 ? (
        <ul ref={listRef} className={ui.cls('list')} onKeyDown={onKeyDown}>
          {q.items.map((item) => (
            <li key={item.id} className={ui.cls('listItem')}>
              {renderItem
                ? renderItem(item, item.id === selectedId)
                : <ApprovalCard item={item} selected={item.id === selectedId} onSelect={onSelect} labels={overrides} {...ui.pass} />}
            </li>
          ))}
        </ul>
      ) : null}
      {q.hasMore ? (
        <Btn ui={ui} variant="ghost" onClick={() => void q.loadMore()} disabled={q.loadingMore}>
          {q.loadingMore ? labels.loading : labels.loadMore}
        </Btn>
      ) : null}
    </section>
  )
}
