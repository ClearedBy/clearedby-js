import { useClearedBy, useLabels, useUi } from '../context'
import { describeAction } from '../describe'
import type { LabelOverrides } from '../labels'
import type { Approval } from '../types'
import type { StyleProps } from '../ui'
import { relativeTime, StatusBadge, useFormatters } from './util'

export interface ApprovalCardProps extends StyleProps {
  item: Approval
  selected?: boolean
  onSelect?: (item: Approval) => void
  labels?: LabelOverrides
}

/** One queue entry: what the assistant wants to do, in a sentence. A button. */
export function ApprovalCard({ item, selected, onSelect, labels: overrides, ...style }: ApprovalCardProps) {
  const labels = useLabels(overrides)
  const ui = useUi(style)
  const f = useFormatters()
  const { locale } = useClearedBy()
  const { title, sentence } = describeAction(item, f)
  const dual = item.dual_review
  return (
    <button
      type="button"
      className={[ui.cls('card', selected && 'cardSelected'), style.className].filter(Boolean).join(' ') || undefined}
      aria-current={selected ? 'true' : undefined}
      onClick={() => onSelect?.(item)}
      data-cb-card=""
      data-id={item.id}
    >
      <span className={ui.cls('cardTop')}>
        <span className={ui.cls('cardTitle')}>{title}</span>
        <StatusBadge status={item.status} labels={labels} ui={ui} />
      </span>
      <span className={ui.cls('cardSentence')}>{sentence}</span>
      <span className={ui.cls('cardMeta')}>
        <time dateTime={item.created_at}>{relativeTime(item.created_at, locale)}</time>
        {dual !== null && dual !== undefined && (item.status === 'pending' || item.status === 'escalated') ? (
          <span> · {labels.needsTwo(dual.approvals.length, dual.required)}</span>
        ) : null}
      </span>
    </button>
  )
}
