import { useEffect, useState, type FormEvent } from 'react'
import { useLabels, useUi } from '../context'
import { MIN_REASON_LENGTH, REASON_REQUIRED, useDecide, usePermissions } from '../hooks'
import type { LabelOverrides } from '../labels'
import type { DecideResult, Decision } from '../types'
import { useDomId, type StyleProps } from '../ui'
import { Btn, errorText } from './util'

const ORDER: Decision[] = ['clear', 'reject', 'send_back', 'escalate']
const VARIANT: Record<Decision, 'primary' | 'danger' | 'secondary'> = {
  clear: 'primary',
  reject: 'danger',
  send_back: 'secondary',
  escalate: 'secondary',
}

export interface DecisionBarProps extends StyleProps {
  id: string
  labels?: LabelOverrides
  /** Hand escalations to this person (your id for them). Default: the most senior reviewer who can cover it. */
  escalateTo?: string
  onDecided?: (result: DecideResult, decision: Decision) => void
}

const focusById = (id: string) => {
  if (typeof document !== 'undefined') document.getElementById(id)?.focus()
}

/**
 * The buttons a reviewer may press — only the ones they are allowed to, from
 * the server's own checks. Declining and sending back ask for a short note first.
 */
export function DecisionBar({ id, labels: overrides, escalateTo, onDecided, ...style }: DecisionBarProps) {
  const labels = useLabels(overrides)
  const ui = useUi(style)
  const perms = usePermissions(id)
  const d = useDecide(id)
  const [open, setOpen] = useState<Exclude<Decision, 'clear'> | null>(null)
  const [reason, setReason] = useState('')
  const [invalid, setInvalid] = useState(false)
  const [done, setDone] = useState<DecideResult | null>(null)
  const fieldId = useDomId('cbr')
  const errId = useDomId('cbe')

  // A different item: start over.
  useEffect(() => {
    setOpen(null)
    setReason('')
    setInvalid(false)
    setDone(null)
    d.reset()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  useEffect(() => {
    if (open !== null) focusById(fieldId)
  }, [open, fieldId])

  const submit = async (decision: Decision, note?: string) => {
    try {
      const result = await d.decide(decision, { reason: note, ...(decision === 'escalate' && escalateTo ? { escalateTo } : {}) })
      setDone(result)
      setOpen(null)
      setReason('')
      onDecided?.(result, decision)
    } catch {
      /* shown from d.error */
    }
  }

  const onSubmitForm = (e: FormEvent) => {
    e.preventDefault()
    if (open === null) return
    if (REASON_REQUIRED.includes(open) && reason.trim().length < MIN_REASON_LENGTH) {
      setInvalid(true)
      focusById(fieldId)
      return
    }
    setInvalid(false)
    void submit(open, reason)
  }

  if (done !== null) {
    return (
      <div className={ui.root()}>
        <p role="status" className={ui.cls('success')}>{labels.decided[done.status] ?? labels.decided.cleared}</p>
      </div>
    )
  }
  if (perms.data === undefined) {
    return perms.error !== undefined
      ? <div role="alert" className={ui.root('error')}>{errorText(perms.error, labels)}</div>
      : <div className={ui.root()}><p role="status" className={ui.cls('status')}>{labels.loading}</p></div>
  }

  const can = ORDER.filter((x) => perms.data!.can.includes(x))
  if (can.length === 0) {
    const why = perms.data.cannot.find((c) => c.decision === 'clear') ?? perms.data.cannot[0]
    return (
      <div className={ui.root()}>
        <p className={ui.cls('hint')}>{(why && labels.cannot[why.code]) ?? labels.nothingToDo}</p>
      </div>
    )
  }
  const clearBlocked = !can.includes('clear') ? perms.data.cannot.find((c) => c.decision === 'clear') : undefined

  return (
    <div className={ui.root()}>
      {clearBlocked && labels.cannot[clearBlocked.code] ? <p className={ui.cls('hint')}>{labels.cannot[clearBlocked.code]}</p> : null}
      {open === null ? (
        <div className={ui.cls('buttonRow')} role="group" aria-label={labels.decisionGroup}>
          {can.map((decision) => (
            <Btn
              key={decision}
              ui={ui}
              variant={VARIANT[decision]}
              disabled={d.pending}
              onClick={() => {
                d.reset()
                if (decision === 'clear') void submit('clear')
                else setOpen(decision)
              }}
            >
              {d.pending && decision === 'clear' ? labels.working : labels.decisions[decision]}
            </Btn>
          ))}
        </div>
      ) : (
        <form className={ui.cls('form')} onSubmit={onSubmitForm} noValidate>
          <label htmlFor={fieldId} className={ui.cls('label')}>{labels.reasonPrompt[open]}</label>
          <ui.C.Textarea
            id={fieldId}
            className={ui.cls('textarea')}
            rows={3}
            value={reason}
            placeholder={labels.reasonPlaceholder[open]}
            required={REASON_REQUIRED.includes(open)}
            aria-required={REASON_REQUIRED.includes(open)}
            aria-invalid={invalid || undefined}
            aria-describedby={invalid ? errId : undefined}
            maxLength={4000}
            onChange={(e) => {
              setReason(e.target.value)
              if (invalid && e.target.value.trim().length >= MIN_REASON_LENGTH) setInvalid(false)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setOpen(null)
            }}
          />
          {invalid ? <p id={errId} role="alert" className={ui.cls('error')}>{labels.reasonTooShort}</p> : null}
          <div className={ui.cls('buttonRow')}>
            <Btn ui={ui} type="submit" variant={open === 'reject' ? 'danger' : 'primary'} disabled={d.pending}>
              {d.pending ? labels.working : labels.confirm[open]}
            </Btn>
            <Btn ui={ui} variant="ghost" onClick={() => { setOpen(null); setInvalid(false) }} disabled={d.pending}>
              {labels.cancel}
            </Btn>
          </div>
        </form>
      )}
      {d.error !== null ? <p role="alert" className={ui.cls('error')}>{errorText(d.error, labels, labels.actionError)}</p> : null}
    </div>
  )
}
