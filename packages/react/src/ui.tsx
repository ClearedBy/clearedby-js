// Styling hooks-in, three levels deep:
//
//   1. Theme tokens — the default stylesheet reads only --cb-* variables (with
//      neutral, dark-mode-friendly fallbacks), set from a ClearedByTheme.
//   2. Per-part classes — every component takes `className` plus a
//      `classNames` slot map, and `unstyled` drops every default `cb-*` class
//      (for Tailwind / shadcn users who style everything themselves).
//   3. Your own components — `components={{ Button, Input, Textarea, Select,
//      Badge, Dialog }}` on the provider renders those parts with your design
//      system. The defaults are plain, accessible elements.

import type {
  ButtonHTMLAttributes,
  ComponentType,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react'
import { useEffect, useId } from 'react'

/** Every styleable part. Pass any subset as `classNames`. */
export interface ClassNames {
  root: string
  heading: string
  subheading: string
  text: string
  hint: string
  status: string
  success: string
  error: string
  warning: string
  list: string
  listItem: string
  card: string
  cardSelected: string
  cardTop: string
  cardTitle: string
  cardSentence: string
  cardMeta: string
  badge: string
  badgeWaiting: string
  badgeOk: string
  badgeBad: string
  badgeWarn: string
  badgeMuted: string
  button: string
  primaryButton: string
  secondaryButton: string
  dangerButton: string
  ghostButton: string
  link: string
  buttonRow: string
  form: string
  field: string
  label: string
  input: string
  textarea: string
  select: string
  checkbox: string
  checkboxLabel: string
  header: string
  kicker: string
  meta: string
  section: string
  note: string
  kv: string
  kvRow: string
  kvTerm: string
  kvValue: string
  tableWrap: string
  table: string
  tableHeadCell: string
  tableRow: string
  tableRowHeader: string
  tableCell: string
  pager: string
  evidence: string
  evidenceGroup: string
  evidenceVerified: string
  evidenceComputed: string
  evidenceAgent: string
  evidenceBadge: string
  evidenceItem: string
  evidenceLabel: string
  evidenceValue: string
  evidenceList: string
  callout: string
  diff: string
  diffBefore: string
  diffAfter: string
  timeline: string
  timelineItem: string
  timelineRevision: string
  timelineTime: string
  dialog: string
  dialogTitle: string
}

export type Slot = keyof ClassNames

/** The default `cb-*` classes (dropped entirely with `unstyled`). */
export const DEFAULT_CLASSES: ClassNames = {
  root: 'cb-root',
  heading: 'cb-heading',
  subheading: 'cb-subheading',
  text: 'cb-text',
  hint: 'cb-hint',
  status: 'cb-status',
  success: 'cb-success',
  error: 'cb-error',
  warning: 'cb-warning',
  list: 'cb-list',
  listItem: 'cb-list-item',
  card: 'cb-card',
  cardSelected: 'cb-card--selected',
  cardTop: 'cb-card-top',
  cardTitle: 'cb-card-title',
  cardSentence: 'cb-card-sentence',
  cardMeta: 'cb-card-meta',
  badge: 'cb-badge',
  badgeWaiting: 'cb-badge--waiting',
  badgeOk: 'cb-badge--ok',
  badgeBad: 'cb-badge--bad',
  badgeWarn: 'cb-badge--warn',
  badgeMuted: 'cb-badge--muted',
  button: 'cb-button',
  primaryButton: 'cb-button--primary',
  secondaryButton: 'cb-button--secondary',
  dangerButton: 'cb-button--danger',
  ghostButton: 'cb-button--ghost',
  link: 'cb-link',
  buttonRow: 'cb-button-row',
  form: 'cb-form',
  field: 'cb-field',
  label: 'cb-label',
  input: 'cb-input',
  textarea: 'cb-textarea',
  select: 'cb-select',
  checkbox: 'cb-checkbox',
  checkboxLabel: 'cb-checkbox-label',
  header: 'cb-header',
  kicker: 'cb-kicker',
  meta: 'cb-meta',
  section: 'cb-section',
  note: 'cb-note',
  kv: 'cb-kv',
  kvRow: 'cb-kv-row',
  kvTerm: 'cb-kv-term',
  kvValue: 'cb-kv-value',
  tableWrap: 'cb-table-wrap',
  table: 'cb-table',
  tableHeadCell: 'cb-table-head',
  tableRow: 'cb-table-row',
  tableRowHeader: 'cb-table-rowhead',
  tableCell: 'cb-table-cell',
  pager: 'cb-pager',
  evidence: 'cb-evidence',
  evidenceGroup: 'cb-evidence-group',
  evidenceVerified: 'cb-evidence-group--verified',
  evidenceComputed: 'cb-evidence-group--computed',
  evidenceAgent: 'cb-evidence-group--agent',
  evidenceBadge: 'cb-evidence-badge',
  evidenceItem: 'cb-evidence-item',
  evidenceLabel: 'cb-evidence-label',
  evidenceValue: 'cb-evidence-value',
  evidenceList: 'cb-evidence-list',
  callout: 'cb-callout',
  diff: 'cb-diff',
  diffBefore: 'cb-diff-before',
  diffAfter: 'cb-diff-after',
  timeline: 'cb-timeline',
  timelineItem: 'cb-timeline-item',
  timelineRevision: 'cb-timeline-item--revision',
  timelineTime: 'cb-timeline-time',
  dialog: 'cb-dialog',
  dialogTitle: 'cb-dialog-title',
}

/** Props every component accepts for styling. */
export interface StyleProps {
  /** Extra class on the component's root element. */
  className?: string
  /** Extra classes per part (merged with the provider's). */
  classNames?: Partial<ClassNames>
  /** Drop every default `cb-*` class (overrides the provider's setting). */
  unstyled?: boolean
}

// ---- injectable components --------------------------------------------------------

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost'
export type BadgeTone = 'waiting' | 'ok' | 'bad' | 'warn' | 'muted'

export interface UiButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Map this to your design system's variant (e.g. shadcn: danger → "destructive"). */
  variant: ButtonVariant
}
export type UiInputProps = InputHTMLAttributes<HTMLInputElement>
export type UiTextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>
export type UiSelectProps = SelectHTMLAttributes<HTMLSelectElement>
export interface UiBadgeProps {
  tone: BadgeTone
  className?: string
  children?: ReactNode
}
export interface UiDialogProps {
  open: boolean
  /** Close without confirming (Escape, Cancel). */
  onClose: () => void
  title: ReactNode
  /** Put this id on your title element so the dialog is labelled. */
  titleId: string
  className?: string
  titleClassName?: string
  children?: ReactNode
}

/** Swap in your design system's parts. Anything you leave out uses the default. */
export interface UiComponents {
  Button: ComponentType<UiButtonProps>
  Input: ComponentType<UiInputProps>
  Textarea: ComponentType<UiTextareaProps>
  Select: ComponentType<UiSelectProps>
  Badge: ComponentType<UiBadgeProps>
  Dialog: ComponentType<UiDialogProps>
}

function DefaultButton({ variant: _variant, type, ...rest }: UiButtonProps) {
  return <button type={type ?? 'button'} {...rest} />
}
const DefaultInput = (props: UiInputProps) => <input {...props} />
const DefaultTextarea = (props: UiTextareaProps) => <textarea {...props} />
const DefaultSelect = (props: UiSelectProps) => <select {...props} />
const DefaultBadge = ({ className, children }: UiBadgeProps) => <span className={className}>{children}</span>

function DefaultDialog({ open, onClose, title, titleId, className, titleClassName, children }: UiDialogProps) {
  useEffect(() => {
    if (!open) return undefined
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null
  // Inline (non-modal) so it sits in the flow of the host page; swap in your own modal via `components.Dialog`.
  return (
    <div role="dialog" aria-modal="false" aria-labelledby={titleId} className={className}>
      <h3 id={titleId} className={titleClassName}>{title}</h3>
      {children}
    </div>
  )
}

export const DEFAULT_COMPONENTS: UiComponents = {
  Button: DefaultButton,
  Input: DefaultInput,
  Textarea: DefaultTextarea,
  Select: DefaultSelect,
  Badge: DefaultBadge,
  Dialog: DefaultDialog,
}

// ---- class resolution -------------------------------------------------------------

export interface UiConfig {
  classNames: Partial<ClassNames>
  unstyled: boolean
  components: UiComponents
}

export const join = (...parts: Array<string | false | null | undefined>): string | undefined => {
  const s = parts.filter(Boolean).join(' ')
  return s === '' ? undefined : s
}

export interface Ui {
  /** Class for one or more slots: the defaults (unless unstyled) + provider + component classes. */
  cls: (...slots: Array<Slot | false | null | undefined>) => string | undefined
  /** The root class: `cls('root', ...)` plus the component's `className`. */
  root: (...slots: Array<Slot | false | null | undefined>) => string | undefined
  C: UiComponents
  /** Forward to child components so they style the same way. */
  pass: { classNames?: Partial<ClassNames>; unstyled?: boolean }
  unstyled: boolean
}

function withoutRoot(c: Partial<ClassNames> | undefined): Partial<ClassNames> | undefined {
  if (c === undefined || c.root === undefined) return c
  const { root: _root, ...rest } = c
  return rest
}

export function resolveUi(config: UiConfig, props: StyleProps): Ui {
  const unstyled = props.unstyled ?? config.unstyled
  const cls = (...slots: Array<Slot | false | null | undefined>) =>
    join(
      ...slots.flatMap((s) => (s ? [unstyled ? undefined : DEFAULT_CLASSES[s], config.classNames[s], props.classNames?.[s]] : [])),
    )
  return {
    cls,
    root: (...slots) => join(cls('root', ...slots), props.className),
    C: config.components,
    // Children inherit the part classes, but not this component's own root class.
    pass: { classNames: withoutRoot(props.classNames), unstyled: props.unstyled },
    unstyled,
  }
}

/** A stable id usable in attribute selectors and aria references. */
export function useDomId(prefix = 'cb'): string {
  return `${prefix}-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
}
