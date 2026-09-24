import { useEffect, useMemo, useState } from 'react'
import { useLabels, useUi } from '../context'
import { batchSummary, changeRowsFor, describeAction, detailRows, isBatch } from '../describe'
import { useApproval } from '../hooks'
import type { LabelOverrides } from '../labels'
import type { Approval, DecideResult, Decision } from '../types'
import { useDomId, type StyleProps } from '../ui'
import { CancelButton } from './CancelButton'
import { DecisionBar } from './DecisionBar'
import { EvidenceList } from './Evidence'
import { History } from './History'
import { Btn, StatusBadge, useFormatters } from './util'

export interface ChangesTableProps extends StyleProps {
  item: Pick<Approval, 'action' | 'params'>
  /** Rows per page. Default 50. */
  pageSize?: number
  labels?: LabelOverrides
}

/**
 * Before/after for a batch. Pages through the changes (only the visible page
 * is built), with a summary on top, so a 3,000-product batch stays quick.
 */
export function ChangesTable({ item, pageSize = 50, labels: overrides, ...style }: ChangesTableProps) {
  const labels = useLabels(overrides)
  const ui = useUi(style)
  const f = useFormatters()
  const total = Array.isArray(item.params?.changes) ? (item.params!.changes as unknown[]).length : 0
  const [page, setPage] = useState(0)
  const pages = Math.max(1, Math.ceil(total / pageSize))
  // Refreshes hand us a new object for the same batch; only a smaller batch moves the page.
  useEffect(() => setPage((p) => Math.min(p, pages - 1)), [pages])
  const from = page * pageSize
  const to = Math.min(total, from + pageSize)
  const rows = useMemo(() => changeRowsFor(item, f, from, to), [item, f, from, to])
  const summary = useMemo(() => batchSummary(item, f), [item, f])
  const captionId = useDomId('cbp')

  return (
    <div className={style.className}>
      <p className={ui.cls('text')}>
        <strong>{labels.changesSummary(total)}</strong>
        {summary.length > 0 ? <span className={ui.cls('hint')}> · {summary.join(' · ')}</span> : null}
      </p>
      <div className={ui.cls('tableWrap')}>
        <table className={ui.cls('table')} aria-describedby={captionId}>
          <thead>
            <tr className={ui.cls('tableRow')}>
              <th scope="col" className={ui.cls('tableHeadCell')}>{labels.columnItem}</th>
              <th scope="col" className={ui.cls('tableHeadCell')}>{labels.columnBefore}</th>
              <th scope="col" className={ui.cls('tableHeadCell')}>{labels.columnAfter}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className={ui.cls('tableRow')}>
                <th scope="row" className={ui.cls('tableRowHeader')}>{r.item}</th>
                <td className={ui.cls('tableCell')}>{r.before}</td>
                <td className={ui.cls('tableCell')} data-after="">{r.after}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className={ui.cls('pager')}>
        <span id={captionId} className={ui.cls('hint')} aria-live="polite">
          {total > 0 ? labels.showing(from + 1, to, total) : ''}
        </span>
        {pages > 1 ? (
          <span className={ui.cls('buttonRow')}>
            <Btn ui={ui} variant="ghost" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}>
              {labels.previousPage}
            </Btn>
            <Btn ui={ui} variant="ghost" onClick={() => setPage((p) => Math.min(pages - 1, p + 1))} disabled={page >= pages - 1}>
              {labels.nextPage}
            </Btn>
          </span>
        ) : null}
      </div>
    </div>
  )
}

export interface ReviewPanelProps extends StyleProps {
  id: string
  labels?: LabelOverrides
  /** Show the decision buttons on open items. Default true. */
  showDecisionBar?: boolean
  /** Show "Cancel before it runs" on approved items. Default true. */
  showCancel?: boolean
  /** Show the timeline. Default true. */
  showHistory?: boolean
  escalateTo?: string
  onDecided?: (result: DecideResult, decision: Decision) => void
  pageSize?: number
}

/**
 * Everything a reviewer needs to decide one item: what will happen, in plain
 * English; the before/after table for a batch; the facts, grouped by who
 * vouches for them; the buttons they're allowed to press; and the history.
 */
export function ReviewPanel(props: ReviewPanelProps) {
  const { id, labels: overrides, showDecisionBar = true, showCancel = true, showHistory = true, escalateTo, onDecided, pageSize, ...style } = props
  const labels = useLabels(overrides)
  const ui = useUi(style)
  const f = useFormatters()
  const a = useApproval(id)
  const headingId = useDomId('cbh')
  // Keep the decision bar (and its "Approved." confirmation) up after deciding here.
  const [decidedHere, setDecidedHere] = useState<string | null>(null)
  const child = { labels: overrides, ...ui.pass }

  if (a.data === undefined) {
    return (
      <section className={ui.root()} aria-busy={a.error === undefined}>
        {a.error !== undefined
          ? <div role="alert" className={ui.cls('error')}>{labels.loadError} <button type="button" className={ui.cls('link')} onClick={() => void a.revalidate()}>{labels.retry}</button></div>
          : <p role="status" className={ui.cls('status')}>{labels.loading}</p>}
      </section>
    )
  }

  const item = a.data
  const { title, sentence } = describeAction(item, f)
  const open = item.status === 'pending' || item.status === 'escalated'
  const why = item.proof?.reason
  const confidence = typeof item.proof?.confidence === 'number' ? Math.round(item.proof.confidence * 100) : null
  const details = isBatch(item) ? [] : detailRows(item, f)

  return (
    <section className={ui.root()} aria-labelledby={headingId}>
      <header className={ui.cls('header')}>
        <p className={ui.cls('kicker')}>{title}</p>
        <h2 id={headingId} className={ui.cls('heading')}>{sentence}</h2>
        <div className={ui.cls('meta')}>
          <StatusBadge status={item.status} labels={labels} ui={ui} />
          {item.attempt > 1 ? <span className={ui.cls('hint')}>{labels.revisionOf(item.attempt)}</span> : null}
          {item.dual_review && open ? <span className={ui.cls('hint')}>{labels.needsTwo(item.dual_review.approvals.length, item.dual_review.required)}</span> : null}
        </div>
        {!open && item.decided_by ? (
          <p className={ui.cls('hint')}>{labels.decidedBy(labels.status[item.status], item.decided_by.name)}</p>
        ) : null}
        {!open && item.reason ? <p className={ui.cls('note')}><strong>{labels.reasonGiven}:</strong> {item.reason}</p> : null}
      </header>

      {why ? (
        <div className={ui.cls('section')}>
          <h3 className={ui.cls('subheading')}>{labels.whyTitle}</h3>
          <p className={ui.cls('text')}>{why}</p>
          {confidence !== null ? <p className={ui.cls('hint')}>{labels.confidence(confidence)}</p> : null}
        </div>
      ) : null}

      {isBatch(item) ? (
        <div className={ui.cls('section')}>
          <h3 className={ui.cls('subheading')}>{labels.changesTitle}</h3>
          <ChangesTable key={item.id} item={item} pageSize={pageSize} {...child} />
        </div>
      ) : details.length > 0 ? (
        <div className={ui.cls('section')}>
          <h3 className={ui.cls('subheading')}>{labels.detailsTitle}</h3>
          <dl className={ui.cls('kv')}>
            {details.map((r) => (
              <div key={r.label} className={ui.cls('kvRow')}>
                <dt className={ui.cls('kvTerm')}>{r.label}</dt>
                <dd className={ui.cls('kvValue')}>{r.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}

      {item.evidence && (item.evidence.claims.length > 0 || item.evidence.verified.length > 0) ? (
        <div className={ui.cls('section')}>
          <h3 className={ui.cls('subheading')}>{labels.evidenceTitle}</h3>
          <EvidenceList
            evidence={item.evidence}
            currency={typeof item.params?.currency === 'string' ? item.params.currency : undefined}
            {...child}
          />
        </div>
      ) : null}

      {showDecisionBar && (open || decidedHere === item.id) ? (
        <div className={ui.cls('section')}>
          <DecisionBar
            id={item.id}
            escalateTo={escalateTo}
            onDecided={(result, decision) => {
              setDecidedHere(item.id)
              onDecided?.(result, decision)
            }}
            {...child}
          />
        </div>
      ) : null}
      {showCancel ? <CancelButton id={item.id} {...child} /> : null}
      {showHistory ? <div className={ui.cls('section')}><History id={item.id} {...child} /></div> : null}
    </section>
  )
}
