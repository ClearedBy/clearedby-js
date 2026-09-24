// @clearedby/react — an embeddable approval UI for your merchants.
//
// The browser only ever talks to YOUR server (the proxy from
// @clearedby/sdk/partner-proxy, mounted at `basePath`). No key or token lives
// in the browser. Import the default look with:
//
//   import '@clearedby/react/styles.css'

export { ClearedByProvider, useClearedBy, useLabels, useUi } from './context'
export type { ClearedByProviderProps, ClearedByContextValue } from './context'

export { DEFAULT_CLASSES, DEFAULT_COMPONENTS } from './ui'
export type {
  ClassNames,
  Slot,
  StyleProps,
  UiComponents,
  UiButtonProps,
  UiInputProps,
  UiTextareaProps,
  UiSelectProps,
  UiBadgeProps,
  UiDialogProps,
  ButtonVariant,
  BadgeTone,
} from './ui'
export { sanitizeTheme, mergeTheme, themeToCssVars, themeToDarkCssVars, themeCss } from './theme'
export type { ClearedByTheme, ClearedByThemeColors, ColorScheme } from './theme'

export {
  useApprovalQueue,
  useApproval,
  usePermissions,
  useHistory,
  useDecide,
  useRevoke,
  useRules,
  useRulesProposal,
  useRevalidate,
  keys,
  REASON_REQUIRED,
  MIN_REASON_LENGTH,
} from './hooks'
export type { QueueOptions, ApprovalQueue as ApprovalQueueState, DecideOptions, UseDecide, UseRevoke, UseRulesProposal } from './hooks'
export type { Resource } from './resource'

export { ApprovalsError } from './client'
export { DEFAULT_LABELS, mergeLabels } from './labels'
export type { Labels, LabelOverrides } from './labels'
export { describeAction, ACTION_TITLES, humanizeAction, shortId, makeFormatters } from './describe'

export { ApprovalQueue } from './components/ApprovalQueue'
export type { ApprovalQueueProps } from './components/ApprovalQueue'
export { ApprovalCard } from './components/ApprovalCard'
export type { ApprovalCardProps } from './components/ApprovalCard'
export { ReviewPanel, ChangesTable } from './components/ReviewPanel'
export type { ReviewPanelProps, ChangesTableProps } from './components/ReviewPanel'
export { EvidenceList, groupEvidence } from './components/Evidence'
export type { EvidenceListProps, EvidenceGroup } from './components/Evidence'
export { DecisionBar } from './components/DecisionBar'
export type { DecisionBarProps } from './components/DecisionBar'
export { RulesSummary } from './components/RulesSummary'
export type { RulesSummaryProps } from './components/RulesSummary'
export { History } from './components/History'
export type { HistoryProps } from './components/History'
export { CancelButton, canCancelBeforeRun } from './components/CancelButton'
export type { CancelButtonProps } from './components/CancelButton'

export type * from './types'
