import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { createClient, type ApprovalsClient } from './client'
import { DEFAULT_LABELS, mergeLabels, type LabelOverrides, type Labels } from './labels'
import { useResource } from './resource'
import { ResourceStore } from './store'
import { mergeTheme, sanitizeTheme, themeCss, type ClearedByTheme, type ColorScheme } from './theme'
import { DEFAULT_COMPONENTS, resolveUi, useDomId, type ClassNames, type StyleProps, type Ui, type UiComponents } from './ui'

export interface ClearedByProviderProps {
  /** Where your server proxy is mounted (see @clearedby/sdk/partner-proxy). Default '/api/clearedby'. */
  basePath?: string
  /** Replace any of the default wording. */
  labels?: LabelOverrides
  /**
   * How often open views refresh while the tab is visible, in ms. Default
   * 15000. Refreshing pauses while the tab is hidden and backs off on errors.
   * 0 turns polling off (use `useRevalidate()` from your own push instead).
   */
  pollInterval?: number
  /** Locale for dates and money. Default: the browser's. */
  locale?: string
  /** Custom fetch (tests, auth headers). Default: the global fetch. */
  fetch?: typeof fetch
  /**
   * Design tokens. Applied on top of the theme your server has stored for this
   * merchant (fetched from `${basePath}/theme`), token by token.
   */
  theme?: ClearedByTheme
  /** Fetch the stored theme from the proxy. Default true. */
  fetchTheme?: boolean
  /** 'auto' (the OS setting), 'class' (a `.dark` ancestor), 'light' or 'dark'. Default 'auto'. */
  colorScheme?: ColorScheme
  /** Extra classes per part, for every component. */
  classNames?: Partial<ClassNames>
  /** Drop every default `cb-*` class everywhere (style it all yourself). */
  unstyled?: boolean
  /** Your design system's Button / Input / Textarea / Select / Badge / Dialog. */
  components?: Partial<UiComponents>
  children?: ReactNode
}

export interface ClearedByContextValue {
  client: ApprovalsClient
  store: ResourceStore
  labels: Labels
  pollInterval: number
  locale: string | undefined
  classNames: Partial<ClassNames>
  unstyled: boolean
  components: UiComponents
}

const Ctx = createContext<ClearedByContextValue | null>(null)

/** Fetches the stored theme (unless disabled) and scopes the --cb-* variables to its children. */
function ThemeScope({ theme, fetchTheme, colorScheme, children }: {
  theme?: ClearedByTheme
  fetchTheme: boolean
  colorScheme: ColorScheme
  children?: ReactNode
}) {
  const { client } = useClearedBy()
  const stored = useResource<{ theme: unknown }>(
    fetchTheme ? 'theme' : null,
    () => client.get<{ theme: unknown }>('/theme'),
    { poll: false },
  )
  const scopeId = useDomId('cbt')
  const css = useMemo(() => {
    const effective = mergeTheme(sanitizeTheme(stored.data?.theme), sanitizeTheme(theme))
    return effective === null ? '' : themeCss(effective, scopeId, colorScheme)
  }, [stored.data, theme, scopeId, colorScheme])
  return (
    // display: contents — a styling scope only, no box of its own.
    <div data-cb-theme={scopeId} style={{ display: 'contents' }}>
      {css === '' ? null : <style data-cb-theme-style={scopeId}>{css}</style>}
      {children}
    </div>
  )
}

export function ClearedByProvider(props: ClearedByProviderProps) {
  const {
    basePath = '/api/clearedby', labels, pollInterval = 15_000, locale, fetch: fetchImpl, children,
    theme, fetchTheme = true, colorScheme = 'auto', classNames, unstyled = false, components,
  } = props
  const client = useMemo(() => createClient(basePath, fetchImpl), [basePath, fetchImpl])
  // One cache per provider (and per basePath) — never shared across mounts.
  const store = useMemo(() => new ResourceStore(), [client])
  const merged = useMemo(() => mergeLabels(DEFAULT_LABELS, labels), [labels])
  const comps = useMemo(() => ({ ...DEFAULT_COMPONENTS, ...components }), [components])
  const value = useMemo<ClearedByContextValue>(
    () => ({ client, store, labels: merged, pollInterval, locale, classNames: classNames ?? {}, unstyled, components: comps }),
    [client, store, merged, pollInterval, locale, classNames, unstyled, comps],
  )
  return (
    <Ctx.Provider value={value}>
      <ThemeScope theme={theme} fetchTheme={fetchTheme} colorScheme={colorScheme}>{children}</ThemeScope>
    </Ctx.Provider>
  )
}

export function useClearedBy(): ClearedByContextValue {
  const v = useContext(Ctx)
  if (v === null) throw new Error('Wrap your approval components in <ClearedByProvider>.')
  return v
}

/** Labels for a component: the provider's, with that component's own overrides on top. */
export function useLabels(overrides?: LabelOverrides): Labels {
  const { labels } = useClearedBy()
  return useMemo(() => mergeLabels(labels, overrides), [labels, overrides])
}

/** Class + component resolution for a component (provider settings + its own props). */
export function useUi(props: StyleProps): Ui {
  const { classNames, unstyled, components } = useClearedBy()
  return resolveUi({ classNames, unstyled, components }, props)
}
