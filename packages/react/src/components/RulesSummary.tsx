import { useState, type ReactNode } from 'react'
import { useLabels, useUi } from '../context'
import { useRules, useRulesProposal } from '../hooks'
import type { LabelOverrides, Labels } from '../labels'
import type { ProposeResult, RulesDiffLine, RulesSettings } from '../types'
import { useDomId, type StyleProps, type Ui } from '../ui'
import { Btn, errorText } from './util'

export interface RulesSummaryProps extends StyleProps {
  labels?: LabelOverrides
  /** Called when the merchant taps "Looks good" (the rules are already on). */
  onLooksGood?: () => void
  /** Called after a change is live (saved stricter, or accepted). */
  onChanged?: () => void
}

/** Spot-check frequencies offered as "About 1 in N" (value = %). */
const SPOT_OPTIONS = [10, 5, 2]

function DiffList({ diff, ui }: { diff: RulesDiffLine[]; ui: Ui }) {
  return (
    <ul className={ui.cls('diff')}>
      {diff.map((d, i) => (
        <li key={`${d.key}:${i}`}>
          {d.before ? <span className={ui.cls('diffBefore')}>{d.before}</span> : null}
          {d.before && d.after ? <span aria-hidden="true"> → </span> : null}
          {d.after ? <strong className={ui.cls('diffAfter')}>{d.after}</strong> : null}
        </li>
      ))}
    </ul>
  )
}

function NumberField({ ui, id, label, value, onChange, min = 0, max, extra }: {
  ui: Ui
  id: string
  label: string
  value: number | null
  onChange: (n: number) => void
  min?: number
  max?: number
  extra?: ReactNode
}) {
  return (
    <div className={ui.cls('field')}>
      <label htmlFor={id} className={ui.cls('label')}>{label}</label>
      <ui.C.Input
        id={id}
        className={ui.cls('input')}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        disabled={value === null}
        value={value === null || !Number.isFinite(value) ? '' : value}
        onChange={(e) => onChange(e.target.value === '' ? 0 : Number(e.target.value))}
      />
      {extra}
    </div>
  )
}

function Check({ ui, checked, onChange, children, describedBy, role }: {
  ui: Ui
  checked: boolean
  onChange: (v: boolean) => void
  children: ReactNode
  describedBy?: string
  role?: 'switch'
}) {
  return (
    <label className={ui.cls('checkboxLabel')}>
      <input
        type="checkbox"
        className={ui.cls('checkbox')}
        role={role}
        aria-checked={role === 'switch' ? checked : undefined}
        aria-describedby={describedBy}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />{' '}
      {children}
    </label>
  )
}

function NullableField(props: {
  ui: Ui
  id: string
  label: string
  value: number | null
  onChange: (n: number | null) => void
  labels: Labels
  fallback: number
}) {
  const { ui, value, onChange, labels, fallback } = props
  return (
    <NumberField
      {...props}
      onChange={(n) => onChange(n)}
      extra={<Check ui={ui} checked={value === null} onChange={(off) => onChange(off ? null : fallback)}>{labels.never}</Check>}
    />
  )
}

/** Only the settings that differ from the current ones. */
function changed(before: RulesSettings, after: RulesSettings): Partial<RulesSettings> {
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(after) as (keyof RulesSettings)[]) {
    if (after[k] !== before[k]) out[k] = after[k]
  }
  return out as Partial<RulesSettings>
}

const withDefaults = (s: RulesSettings): RulesSettings => ({ spot_checks: false, spot_check_pct: 5, ...s })

/**
 * "Your approval rules": the merchant's rules in plain English with "Looks
 * good" / "Adjust". Adjusting shows simple controls; a change that makes the
 * rules looser is confirmed by an owner (in your `Dialog`, if you provide one),
 * or waits for one.
 */
export function RulesSummary({ labels: overrides, onLooksGood, onChanged, ...style }: RulesSummaryProps) {
  const labels = useLabels(overrides)
  const ui = useUi(style)
  const rules = useRules()
  const prop = useRulesProposal()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<RulesSettings | null>(null)
  const [confirm, setConfirm] = useState<Extract<ProposeResult, { status: 'needs_owner_approval' }> | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const headingId = useDomId('cbrh')
  const fid = useDomId('cbrf')

  if (rules.data === undefined) {
    return (
      <section className={ui.root()}>
        {rules.error !== undefined
          ? <div role="alert" className={ui.cls('error')}>{labels.loadError} <button type="button" className={ui.cls('link')} onClick={() => void rules.revalidate()}>{labels.retry}</button></div>
          : <p role="status" className={ui.cls('status')}>{labels.loading}</p>}
      </section>
    )
  }

  const r = rules.data
  const viewer = r.viewer ?? { role: null, can_edit: true, can_accept: false }
  const pending = r.pending_proposal
  const settings = r.settings

  const set = <K extends keyof RulesSettings>(k: K, v: RulesSettings[K]) => setDraft((d) => (d === null ? d : { ...d, [k]: v }))

  const startEdit = () => {
    if (settings === null) return
    setDraft(withDefaults(settings))
    setEditing(true)
    setMessage(null)
    setConfirm(null)
    prop.reset()
  }

  const save = async () => {
    if (draft === null || settings === null) return
    const diff = changed(withDefaults(settings), draft)
    if (Object.keys(diff).length === 0) {
      setEditing(false)
      setMessage(labels.rulesUnchanged)
      return
    }
    try {
      const res = await prop.propose(diff)
      setEditing(false)
      if (res.status === 'active') {
        setMessage(labels.rulesSaved)
        onChanged?.()
      } else if (viewer.can_accept) {
        setConfirm(res)
        setMessage(null)
      } else {
        setMessage(labels.rulesNeedOwner)
      }
    } catch {
      /* shown below */
    }
  }

  const accept = async (proposalId: string) => {
    try {
      await prop.accept(proposalId)
      setConfirm(null)
      setMessage(labels.rulesAccepted)
      onChanged?.()
    } catch {
      /* shown below */
    }
  }

  const spotOptions = draft !== null && draft.spot_check_pct !== undefined && !SPOT_OPTIONS.includes(draft.spot_check_pct)
    ? [...SPOT_OPTIONS, draft.spot_check_pct].sort((a, b) => b - a)
    : SPOT_OPTIONS
  const money = (label: string) => `${label} (${r.currency})`

  return (
    <section className={ui.root()} aria-labelledby={headingId}>
      <h2 id={headingId} className={ui.cls('heading')}>{labels.rulesTitle}</h2>
      <p className={ui.cls('hint')}>{labels.rulesIntro}</p>

      {!editing ? (
        <ul className={ui.cls('list')}>
          {r.summary.map((line, i) => <li key={`${line.key}:${i}`} className={ui.cls('listItem')}>{line.sentence}</li>)}
        </ul>
      ) : null}

      <ui.C.Dialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={labels.rulesLooserTitle}
        titleId={`${fid}-looser`}
        className={ui.cls('dialog', 'callout')}
        titleClassName={ui.cls('dialogTitle')}
      >
        {confirm !== null ? (
          <>
            <DiffList diff={confirm.summary_diff} ui={ui} />
            <div className={ui.cls('buttonRow')}>
              <Btn ui={ui} variant="primary" disabled={prop.pending} onClick={() => void accept(confirm.proposal_id)}>
                {prop.pending ? labels.working : labels.rulesYesChange}
              </Btn>
              <Btn ui={ui} variant="ghost" onClick={() => setConfirm(null)}>{labels.cancel}</Btn>
            </div>
          </>
        ) : null}
      </ui.C.Dialog>

      {confirm === null && pending !== undefined && !editing ? (
        <div className={ui.cls('callout')}>
          <h3 className={ui.cls('subheading')}>{viewer.can_accept ? labels.rulesPendingTitle : labels.rulesNeedOwner}</h3>
          <DiffList diff={pending.summary_diff} ui={ui} />
          {viewer.can_accept ? (
            <div className={ui.cls('buttonRow')}>
              <Btn ui={ui} variant="primary" disabled={prop.pending} onClick={() => void accept(pending.proposal_id)}>
                {prop.pending ? labels.working : labels.rulesYesChange}
              </Btn>
            </div>
          ) : null}
        </div>
      ) : null}

      {editing && draft !== null ? (
        <form className={ui.cls('form')} onSubmit={(e) => { e.preventDefault(); void save() }}>
          <NumberField ui={ui} id={`${fid}-ram`} label={money(labels.settings.refund_auto_max)} value={draft.refund_auto_max} onChange={(n) => set('refund_auto_max', n)} />
          <NullableField ui={ui} id={`${fid}-rda`} label={money(labels.settings.refund_dual_above)} value={draft.refund_dual_above} onChange={(n) => set('refund_dual_above', n)} labels={labels} fallback={Math.max(draft.refund_auto_max, 250)} />
          <NullableField ui={ui} id={`${fid}-rdc`} label={money(labels.settings.refund_daily_auto_cap)} value={draft.refund_daily_auto_cap} onChange={(n) => set('refund_daily_auto_cap', n)} labels={labels} fallback={250} />
          <NullableField ui={ui} id={`${fid}-rpo`} label={money(labels.settings.refund_per_order_cap)} value={draft.refund_per_order_cap} onChange={(n) => set('refund_per_order_cap', n)} labels={labels} fallback={25} />
          <NumberField ui={ui} id={`${fid}-tag`} label={labels.settings.tags_auto_max_products} value={draft.tags_auto_max_products} onChange={(n) => set('tags_auto_max_products', n)} />
          <NumberField ui={ui} id={`${fid}-inv`} label={labels.settings.inventory_auto_max_items} value={draft.inventory_auto_max_items} onChange={(n) => set('inventory_auto_max_items', n)} />
          <div className={ui.cls('field')}>
            <label htmlFor={`${fid}-pc`} className={ui.cls('label')}>{labels.settings.price_changes}</label>
            <ui.C.Select id={`${fid}-pc`} className={ui.cls('select')} value={draft.price_changes} onChange={(e) => set('price_changes', e.target.value as RulesSettings['price_changes'])}>
              <option value="always_review">{labels.settings.price_changes_always}</option>
              <option value="review_drops_over_pct">{labels.settings.price_changes_drops}</option>
            </ui.C.Select>
          </div>
          {draft.price_changes === 'review_drops_over_pct' ? (
            <NumberField ui={ui} id={`${fid}-pd`} label={labels.settings.price_drop_review_pct} value={draft.price_drop_review_pct} max={100} onChange={(n) => set('price_drop_review_pct', n)} />
          ) : null}
          <NumberField ui={ui} id={`${fid}-to`} label={labels.settings.timeout_hours} value={draft.timeout_hours} min={1} max={720} onChange={(n) => set('timeout_hours', n)} />
          <div className={ui.cls('field')}>
            <Check ui={ui} role="switch" checked={draft.spot_checks === true} onChange={(v) => set('spot_checks', v)} describedBy={`${fid}-sc-help`}>
              {labels.settings.spot_checks}
            </Check>
            <p id={`${fid}-sc-help`} className={ui.cls('hint')}>{labels.settings.spot_checks_help}</p>
            {draft.spot_checks === true ? (
              <>
                <label htmlFor={`${fid}-sco`} className={ui.cls('label')}>{labels.settings.spot_check_how_often}</label>
                <ui.C.Select id={`${fid}-sco`} className={ui.cls('select')} value={draft.spot_check_pct ?? 5} onChange={(e) => set('spot_check_pct', Number(e.target.value))}>
                  {spotOptions.map((pct) => <option key={pct} value={pct}>{labels.oneIn(Math.round(100 / pct))}</option>)}
                </ui.C.Select>
              </>
            ) : null}
          </div>
          <div className={ui.cls('buttonRow')}>
            <Btn ui={ui} type="submit" variant="primary" disabled={prop.pending}>{prop.pending ? labels.saving : labels.save}</Btn>
            <Btn ui={ui} variant="ghost" onClick={() => setEditing(false)}>{labels.cancel}</Btn>
          </div>
        </form>
      ) : confirm === null ? (
        <div className={ui.cls('buttonRow')}>
          <Btn ui={ui} variant="primary" onClick={() => { setMessage(null); onLooksGood?.() }}>{labels.looksGood}</Btn>
          {viewer.can_edit && settings !== null ? <Btn ui={ui} variant="secondary" onClick={startEdit}>{labels.adjust}</Btn> : null}
        </div>
      ) : null}

      {message !== null ? <p role="status" className={ui.cls('success')}>{message}</p> : null}
      {prop.error !== null ? <p role="alert" className={ui.cls('error')}>{errorText(prop.error, labels, labels.saveError)}</p> : null}
    </section>
  )
}
