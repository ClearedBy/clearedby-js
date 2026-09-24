// ClearedByTheme: design tokens as data. Set once on the server
// (PATCH /v1/partner/settings {theme}, per org PATCH /v1/partner/orgs/:id
// {theme}); the provider fetches it through your proxy and applies it as --cb-*
// CSS variables, or pass `theme` to <ClearedByProvider> to override it.
//
// Every value is validated here too (the same rules as the server): only CSS
// colours, lengths, font lists and shadows. Anything else is dropped, so a
// theme can never inject CSS.

export interface ClearedByThemeColors {
  /** Buttons, links, focus rings, the selected card. */
  primary?: string
  /** Text on primary buttons. */
  primaryText?: string
  /** Card / panel background (default: transparent, the host page shows through). */
  surface?: string
  /** Subtle background: table headers, notes, neutral badges. */
  surfaceAlt?: string
  border?: string
  /** Body text (default: inherited from the host page). */
  text?: string
  mutedText?: string
  success?: string
  warning?: string
  danger?: string
}

export interface ClearedByTheme {
  colors?: ClearedByThemeColors
  /** Corner radius, e.g. '8px' or '0.5rem'. */
  radius?: string
  /** Font list, e.g. "Inter, system-ui, sans-serif" (default: inherited). */
  fontFamily?: string
  /** Base font size, e.g. '15px' (default: inherited). */
  fontSize?: string
  /** Spacing scale. */
  spacing?: { xs?: string; sm?: string; md?: string; lg?: string }
  /** Card shadow, e.g. '0 1px 2px rgba(0,0,0,.08)' (default: none). */
  shadow?: string
  /** Overrides used in dark mode. */
  dark?: { colors?: ClearedByThemeColors; shadow?: string }
}

export const THEME_COLOR_KEYS = [
  'primary', 'primaryText', 'surface', 'surfaceAlt', 'border', 'text', 'mutedText', 'success', 'warning', 'danger',
] as const satisfies readonly (keyof ClearedByThemeColors)[]

const FORBIDDEN = /url\s*\(|expression|javascript:|image-set|element\s*\(|var\s*\(|attr\s*\(|@import|[;{}<>\\`]|\/\*|\*\//i
const COLOR_FN = /^(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\(\s*[-0-9a-z.%\s,/]{1,80}\)$/i
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const NAMED = /^[a-z]{3,30}$/i
const LENGTH = /^(0|-?(\d+\.?\d*|\.\d+)(px|rem|em|%))$/i
const FONT_LIST = /^[\p{L}\p{N} ,'"._-]{1,200}$/u
const SHADOW = /^[-0-9a-z.%#(),\s/]{1,300}$/i
const COLOR_FN_OPEN = /(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\(/gi

const clean = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' && !FORBIDDEN.test(v) ? v.trim() : null)

export function isCssColor(v: unknown): v is string {
  const s = clean(v)
  return s !== null && s.length <= 100 && (HEX.test(s) || COLOR_FN.test(s) || NAMED.test(s))
}
export function isCssLength(v: unknown): v is string {
  const s = clean(v)
  return s !== null && s.length <= 32 && LENGTH.test(s)
}
export function isFontFamily(v: unknown): v is string {
  const s = clean(v)
  return s !== null && FONT_LIST.test(s)
}
export function isShadow(v: unknown): v is string {
  const s = clean(v)
  if (s === null) return false
  if (s === 'none') return true
  return SHADOW.test(s) && (s.match(/\(/g) ?? []).length === (s.match(COLOR_FN_OPEN) ?? []).length
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

function sanitizeColors(v: unknown): ClearedByThemeColors | undefined {
  if (!isObj(v)) return undefined
  const out: ClearedByThemeColors = {}
  for (const k of THEME_COLOR_KEYS) if (isCssColor(v[k])) out[k] = (v[k] as string).trim()
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * Keep only valid tokens (anything else is silently dropped). Returns null when
 * nothing valid is left. Use it on any theme you didn't write yourself.
 */
export function sanitizeTheme(input: unknown): ClearedByTheme | null {
  if (!isObj(input)) return null
  const t: ClearedByTheme = {}
  const colors = sanitizeColors(input.colors)
  if (colors) t.colors = colors
  if (isCssLength(input.radius)) t.radius = input.radius.trim()
  if (isFontFamily(input.fontFamily)) t.fontFamily = input.fontFamily.trim()
  if (isCssLength(input.fontSize)) t.fontSize = input.fontSize.trim()
  if (isObj(input.spacing)) {
    const sp: NonNullable<ClearedByTheme['spacing']> = {}
    for (const k of ['xs', 'sm', 'md', 'lg'] as const) if (isCssLength(input.spacing[k])) sp[k] = (input.spacing[k] as string).trim()
    if (Object.keys(sp).length > 0) t.spacing = sp
  }
  if (isShadow(input.shadow)) t.shadow = input.shadow.trim()
  if (isObj(input.dark)) {
    const dark: NonNullable<ClearedByTheme['dark']> = {}
    const dc = sanitizeColors(input.dark.colors)
    if (dc) dark.colors = dc
    if (isShadow(input.dark.shadow)) dark.shadow = input.dark.shadow.trim()
    if (Object.keys(dark).length > 0) t.dark = dark
  }
  return Object.keys(t).length > 0 ? t : null
}

/** `over` on top of `base`, token by token. */
export function mergeTheme(base: ClearedByTheme | null | undefined, over: ClearedByTheme | null | undefined): ClearedByTheme | null {
  if (!base) return over ?? null
  if (!over) return base
  const out: ClearedByTheme = { ...base, ...over }
  if (base.colors || over.colors) out.colors = { ...base.colors, ...over.colors }
  if (base.spacing || over.spacing) out.spacing = { ...base.spacing, ...over.spacing }
  if (base.dark || over.dark) {
    out.dark = { ...base.dark, ...over.dark }
    if (base.dark?.colors || over.dark?.colors) out.dark.colors = { ...base.dark?.colors, ...over.dark?.colors }
  }
  return out
}

const COLOR_VARS: Record<keyof ClearedByThemeColors, string> = {
  primary: '--cb-color-primary',
  primaryText: '--cb-color-primary-text',
  surface: '--cb-color-surface',
  surfaceAlt: '--cb-color-surface-alt',
  border: '--cb-color-border',
  text: '--cb-color-text',
  mutedText: '--cb-color-muted',
  success: '--cb-color-success',
  warning: '--cb-color-warning',
  danger: '--cb-color-danger',
}

function colorVars(colors: ClearedByThemeColors | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of THEME_COLOR_KEYS) {
    const v = colors?.[k]
    if (v !== undefined) out[COLOR_VARS[k]] = v
  }
  return out
}

/** The light (base) tokens as CSS custom properties. */
export function themeToCssVars(theme: ClearedByTheme | null | undefined): Record<string, string> {
  const t = sanitizeTheme(theme)
  if (t === null) return {}
  const out = colorVars(t.colors)
  if (t.radius) out['--cb-radius'] = t.radius
  if (t.fontFamily) out['--cb-font'] = t.fontFamily
  if (t.fontSize) out['--cb-font-size'] = t.fontSize
  if (t.spacing?.xs) out['--cb-space-xs'] = t.spacing.xs
  if (t.spacing?.sm) out['--cb-space-sm'] = t.spacing.sm
  if (t.spacing?.md) out['--cb-space-md'] = t.spacing.md
  if (t.spacing?.lg) out['--cb-space-lg'] = t.spacing.lg
  if (t.shadow) out['--cb-shadow'] = t.shadow
  return out
}

/** The dark overrides as CSS custom properties. */
export function themeToDarkCssVars(theme: ClearedByTheme | null | undefined): Record<string, string> {
  const t = sanitizeTheme(theme)
  if (t?.dark === undefined) return {}
  const out = colorVars(t.dark.colors)
  if (t.dark.shadow) out['--cb-shadow'] = t.dark.shadow
  return out
}

export type ColorScheme = 'auto' | 'light' | 'dark' | 'class'

const block = (selector: string, vars: Record<string, string>): string => {
  const body = Object.entries(vars).map(([k, v]) => `${k}:${v};`).join('')
  return body === '' ? '' : `${selector}{${body}}`
}

/**
 * The stylesheet for one themed scope. `colorScheme`: 'auto' follows the OS
 * (prefers-color-scheme), 'class' follows a `.dark` class on an ancestor (the
 * shadcn / Tailwind convention), 'light' / 'dark' force one.
 */
export function themeCss(theme: ClearedByTheme | null | undefined, scopeId: string, colorScheme: ColorScheme = 'auto'): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(scopeId)) return ''
  const scope = `[data-cb-theme="${scopeId}"]`
  const light = themeToCssVars(theme)
  const dark = themeToDarkCssVars(theme)
  if (colorScheme === 'dark') return block(scope, { ...light, ...dark })
  let css = block(scope, light)
  if (colorScheme === 'auto' && Object.keys(dark).length > 0) css += `@media (prefers-color-scheme: dark){${block(scope, dark)}}`
  if (colorScheme === 'class') css += block(`.dark ${scope}`, dark)
  return css
}
