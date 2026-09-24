import { useState, type FormEvent } from 'react'
import { useLabels, useUi } from '../context'
import { MIN_REASON_LENGTH, useApproval, useRevoke } from '../hooks'
import type { LabelOverrides } from '../labels'
import type { Approval, RevokeResult } from '../types'
import { useDomId, type StyleProps } from '../ui'
import { Btn, errorText } from './util'

export interface CancelButtonProps extends StyleProps {
  id: string
  labels?: LabelOverrides
  onCancelled?: (result: RevokeResult) => void
}

/** True while an approved change can still be stopped: approved, and not yet done or failed. */
export function canCancelBeforeRun(item: Pick<Approval, 'status' | 'completion'> | undefined): boolean {
  if (item === undefined || item.status !== 'cleared') return false
  const s = item.completion?.status
  return s !== 'done' && s !== 'failed'
}

/**
 * "Cancel before it runs": stops an approved change that hasn't happened yet.
 * Renders nothing when there is nothing to cancel. The server decides whether
 * this person may (owners and admins, or anyone who could approve it). The
 * confirmation uses your `Dialog` when you provide one.
 */
export function CancelButton({ id, labels: overrides, onCancelled, ...style }: CancelButtonProps) {
  const labels = useLabels(overrides)
  const ui = useUi(style)
  const item = useApproval(id)
  const r = useRevoke(id)
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [invalid, setInvalid] = useState(false)
  const [done, setDone] = useState<RevokeResult | null>(null)
  const fieldId = useDomId('cbc')
  const titleId = useDomId('cbct')

  if (done !== null) {
    const maybeStarted = done.dispatch === 'in_flight' || done.dispatch === 'delivered'
    return <p role="status" className={ui.root('success')}>{maybeStarted ? labels.cancelledButMayHaveStarted : labels.cancelled}</p>
  }
  if (!canCancelBeforeRun(item.data)) return null

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (reason.trim().length < MIN_REASON_LENGTH) {
      setInvalid(true)
      return
    }
    try {
      const res = await r.revoke(reason)
      setDone(res)
      setOpen(false)
      onCancelled?.(res)
    } catch {
      /* shown below */
    }
  }

  return (
    <div className={ui.root()}>
      {!open ? <Btn ui={ui} variant="danger" onClick={() => setOpen(true)}>{labels.cancelBeforeRuns}</Btn> : null}
      <ui.C.Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={labels.cancelBeforeRuns}
        titleId={titleId}
        className={ui.cls('dialog')}
        titleClassName={ui.cls('dialogTitle')}
      >
        <form className={ui.cls('form')} onSubmit={(e) => void onSubmit(e)} noValidate>
          <label htmlFor={fieldId} className={ui.cls('label')}>{labels.cancelPrompt}</label>
          <ui.C.Textarea
            id={fieldId}
            className={ui.cls('textarea')}
            rows={2}
            value={reason}
            placeholder={labels.cancelPlaceholder}
            aria-required
            aria-invalid={invalid || undefined}
            autoFocus
            onChange={(e) => setReason(e.target.value)}
          />
          {invalid ? <p role="alert" className={ui.cls('error')}>{labels.reasonTooShort}</p> : null}
          <div className={ui.cls('buttonRow')}>
            <Btn ui={ui} type="submit" variant="danger" disabled={r.pending}>{r.pending ? labels.working : labels.cancelConfirm}</Btn>
            <Btn ui={ui} variant="ghost" onClick={() => setOpen(false)}>{labels.cancel}</Btn>
          </div>
        </form>
      </ui.C.Dialog>
      {r.error !== null ? <p role="alert" className={ui.cls('error')}>{errorText(r.error, labels, labels.actionError)}</p> : null}
    </div>
  )
}
