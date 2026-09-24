// @clearedby/react/theme — turn the design system you already have into a
// ClearedByTheme. Pure functions (no DOM needed except fromShadcn(element)).
//
//   fromShadcn(globalsCss | cssVars | element)  shadcn/ui CSS variables
//   fromTailwind(resolvedConfig)                 a resolved Tailwind config
//   fromDesignTokens(w3cJson)                    W3C Design Tokens (DTCG) JSON
//
// Every result goes through sanitizeTheme(), so values that aren't plain CSS
// colours / lengths / fonts / shadows (e.g. `hsl(var(--primary))`) are dropped.

import { sanitizeTheme, type ClearedByTheme, type ClearedByThemeColors } from './theme.js'

export { sanitizeTheme, mergeTheme, themeToCssVars, themeCss } from './theme.js'
export type { ClearedByTheme, ClearedByThemeColors } from './theme.js'

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

// ---- shadcn -----------------------------------------------------------------------

/** shadcn variable → token. */
const SHADCN: [string, keyof ClearedByThemeColors][] = [
  ['--primary', 'primary'],
  ['--primary-foreground', 'primaryText'],
  ['--card', 'surface'],
  ['--background', 'surface'],
  ['--muted', 'surfaceAlt'],
  ['--border', 'border'],
  ['--foreground', 'text'],
  ['--card-foreground', 'text'],
  ['--muted-foreground', 'mutedText'],
  ['--destructive', 'danger'],
  ['--success', 'success'],
  ['--warning', 'warning'],
]

/** shadcn v3 stores HSL channels ("222.2 47.4% 11.2%"); v4 stores full colours (oklch(...)). */
function shadcnColor(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const v = raw.trim()
  if (v === '') return undefined
  if (/^-?[\d.]+(deg)?\s+[\d.]+%\s+[\d.]+%(\s*\/\s*[\d.]+%?)?$/.test(v)) return `hsl(${v})`
  return v
}

function parseDeclarations(body: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of body.matchAll(/(--[a-zA-Z0-9-]+)\s*:\s*([^;]+);?/g)) out[m[1] as string] = (m[2] as string).trim()
  return out
}

/** Pull the custom properties of `:root` (and `.dark`) out of a stylesheet. */
export function parseCssVariables(css: string): { light: Record<string, string>; dark: Record<string, string> } {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const light: Record<string, string> = {}
  const dark: Record<string, string> = {}
  for (const m of noComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = (m[1] as string).trim()
    const decls = parseDeclarations(m[2] as string)
    if (/\.dark\b|\[data-theme=["']?dark/.test(selector)) Object.assign(dark, decls)
    else if (/(^|[\s,]):root\b|(^|[\s,])html\b|@theme|(^|[\s,])\.light\b/.test(selector) || selector.startsWith('@layer')) Object.assign(light, decls)
  }
  return { light, dark }
}

function shadcnColors(vars: Record<string, string>): ClearedByThemeColors {
  const out: ClearedByThemeColors = {}
  for (const [name, key] of SHADCN) {
    const v = shadcnColor(vars[name])
    if (v !== undefined && out[key] === undefined) out[key] = v
  }
  return out
}

/**
 * From shadcn/ui: pass your `globals.css` text, a `{ '--primary': '...' }`
 * map, or (in the browser) an element whose computed style carries the
 * variables (e.g. `document.documentElement`).
 */
export function fromShadcn(input: string | Record<string, string> | Element): ClearedByTheme | null {
  let light: Record<string, string>
  let dark: Record<string, string> = {}
  if (typeof input === 'string') {
    ;({ light, dark } = parseCssVariables(input))
  } else if (typeof Element !== 'undefined' && input instanceof Element) {
    const cs = getComputedStyle(input)
    light = {}
    for (const [name] of SHADCN) light[name] = cs.getPropertyValue(name)
    for (const name of ['--radius', '--font-sans']) light[name] = cs.getPropertyValue(name)
  } else {
    light = input as Record<string, string>
  }
  const theme: ClearedByTheme = { colors: shadcnColors(light) }
  if (light['--radius']) theme.radius = light['--radius'].trim()
  if (light['--font-sans']) theme.fontFamily = light['--font-sans'].trim()
  const darkColors = shadcnColors(dark)
  if (Object.keys(darkColors).length > 0) theme.dark = { colors: darkColors }
  return sanitizeTheme(theme)
}

// ---- Tailwind ---------------------------------------------------------------------

type TwColor = string | Record<string, unknown> | undefined

/** A colour from a Tailwind palette entry: a string, or {DEFAULT} / a shade. */
function twPick(c: TwColor, ...shades: string[]): string | undefined {
  if (typeof c === 'string') return c
  if (!isObj(c)) return undefined
  for (const s of ['DEFAULT', ...shades]) if (typeof c[s] === 'string') return c[s] as string
  return undefined
}

function twLength(v: unknown): string | undefined {
  if (typeof v === 'string') return v
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0]
  return undefined
}

/**
 * From a RESOLVED Tailwind config (`resolveConfig(require('./tailwind.config'))`
 * in Tailwind 3). Uses semantic names first (primary, background, border,
 * foreground, muted, destructive…), then the default palette.
 */
export function fromTailwind(config: unknown): ClearedByTheme | null {
  const theme = isObj(config) && isObj(config.theme) ? config.theme : isObj(config) ? config : {}
  const colors = (isObj(theme.colors) ? theme.colors : {}) as Record<string, TwColor>
  const primaryEntry = colors.primary ?? colors.brand ?? colors.blue ?? colors.indigo
  const out: ClearedByTheme = {
    colors: {
      primary: twPick(primaryEntry, '600', '500'),
      primaryText: isObj(colors.primary) ? twPick(colors.primary.foreground as TwColor) : colors.white === undefined ? undefined : twPick(colors.white),
      surface: twPick(colors.background) ?? twPick(colors.card) ?? twPick(colors.white),
      surfaceAlt: twPick(colors.muted) ?? twPick(colors.gray ?? colors.slate, '100'),
      border: twPick(colors.border) ?? twPick(colors.gray ?? colors.slate, '200'),
      text: twPick(colors.foreground) ?? twPick(colors.gray ?? colors.slate, '900'),
      mutedText: (isObj(colors.muted) ? twPick(colors.muted.foreground as TwColor) : undefined) ?? twPick(colors.gray ?? colors.slate, '500'),
      success: twPick(colors.success, '600') ?? twPick(colors.green ?? colors.emerald, '600'),
      warning: twPick(colors.warning, '600') ?? twPick(colors.amber ?? colors.yellow, '600'),
      danger: twPick(colors.destructive, '600') ?? twPick(colors.danger, '600') ?? twPick(colors.red, '600'),
    },
  }
  const radius = isObj(theme.borderRadius) ? theme.borderRadius : {}
  out.radius = twLength(radius.DEFAULT) ?? twLength(radius.lg) ?? twLength(radius.md)
  const fonts = isObj(theme.fontFamily) ? theme.fontFamily : {}
  const sans = fonts.sans
  if (Array.isArray(sans)) out.fontFamily = sans.filter((f) => typeof f === 'string').map((f) => (/\s/.test(f) && !/^["']/.test(f) ? `"${f}"` : f)).join(', ')
  else if (typeof sans === 'string') out.fontFamily = sans
  const fontSize = isObj(theme.fontSize) ? theme.fontSize : {}
  out.fontSize = twLength(fontSize.base)
  const spacing = isObj(theme.spacing) ? theme.spacing : {}
  out.spacing = { xs: twLength(spacing['1']), sm: twLength(spacing['2']), md: twLength(spacing['3']), lg: twLength(spacing['5']) }
  const shadows = isObj(theme.boxShadow) ? theme.boxShadow : {}
  out.shadow = twLength(shadows.sm) ?? twLength(shadows.DEFAULT)
  return sanitizeTheme(out)
}

// ---- W3C Design Tokens (DTCG) -------------------------------------------------------

interface FlatToken {
  path: string
  type: string | undefined
  value: unknown
}

function flatten(node: unknown, path: string[], inheritedType: string | undefined, out: FlatToken[]): void {
  if (!isObj(node)) return
  const type = typeof node.$type === 'string' ? node.$type : inheritedType
  if ('$value' in node) {
    out.push({ path: path.join('.').toLowerCase(), type, value: node.$value })
    return
  }
  for (const [k, v] of Object.entries(node)) if (!k.startsWith('$')) flatten(v, [...path, k], type, out)
}

function resolveAlias(value: unknown, byPath: Map<string, FlatToken>, depth = 0): unknown {
  if (typeof value === 'string' && /^\{[^}]+\}$/.test(value) && depth < 10) {
    const target = byPath.get(value.slice(1, -1).toLowerCase())
    return target === undefined ? undefined : resolveAlias(target.value, byPath, depth + 1)
  }
  return value
}

const dim = (v: unknown): string | undefined => {
  if (typeof v === 'string') return v
  if (typeof v === 'number') return `${v}px`
  if (isObj(v) && typeof v.value === 'number' && typeof v.unit === 'string') return `${v.value}${v.unit}`
  return undefined
}

function shadowString(v: unknown): string | undefined {
  const one = (s: unknown): string | undefined => {
    if (typeof s === 'string') return s
    if (!isObj(s)) return undefined
    const parts = [dim(s.offsetX), dim(s.offsetY), dim(s.blur), dim(s.spread)].map((p) => p ?? '0')
    const color = typeof s.color === 'string' ? s.color : undefined
    return `${s.inset === true ? 'inset ' : ''}${parts.join(' ')}${color ? ` ${color}` : ''}`
  }
  if (Array.isArray(v)) {
    const layers = v.map(one).filter((x): x is string => x !== undefined)
    return layers.length > 0 ? layers.join(', ') : undefined
  }
  return one(v)
}

// Name patterns in priority order; the first token that matches wins.
const COLOR_RULES: [keyof ClearedByThemeColors, RegExp][] = [
  ['primaryText', /(on[-_.]?primary|primary[-_.](foreground|text|contrast|on))/],
  ['primary', /(^|[._-])(primary|brand|accent)([._-](default|base|500|600))?$/],
  ['mutedText', /((text|foreground|fg)[-_.](muted|subtle|secondary|weak))|((muted|subtle)[-_.](text|foreground|fg))/],
  ['text', /(^|[._-])(text|foreground|fg|on[-_.]?(surface|background))([._-](default|base|primary))?$/],
  ['surfaceAlt', /((surface|background|bg)[-_.](alt|subtle|muted|secondary|raised))|(^|[._-])muted$/],
  ['surface', /(^|[._-])(surface|background|bg|canvas|card)([._-](default|base|primary))?$/],
  ['border', /(^|[._-])(border|outline|stroke|divider)([._-](default|base))?$/],
  ['success', /(^|[._-])(success|positive)([._-](default|base|500|600))?$/],
  ['warning', /(^|[._-])(warning|caution|attention)([._-](default|base|500|600))?$/],
  ['danger', /(^|[._-])(danger|error|destructive|negative|critical)([._-](default|base|500|600))?$/],
]

function colorsFrom(tokens: FlatToken[], byPath: Map<string, FlatToken>): ClearedByThemeColors {
  const out: ClearedByThemeColors = {}
  for (const [key, re] of COLOR_RULES) {
    const t = tokens.find((x) => (x.type === 'color' || x.type === undefined) && re.test(x.path))
    const v = t === undefined ? undefined : resolveAlias(t.value, byPath)
    if (typeof v === 'string' && out[key] === undefined) out[key] = v
  }
  return out
}

/**
 * From W3C Design Tokens (DTCG) JSON: `{ "$type": "color", "$value": "#..." }`
 * leaves, `{alias.references}` resolved. Matched by name (primary / brand,
 * background / surface, border, text / foreground, success, warning, danger /
 * error, radius, font family, font size, spacing, shadow). A top-level `dark`
 * group becomes the dark variant.
 */
export function fromDesignTokens(json: unknown): ClearedByTheme | null {
  if (!isObj(json)) return null
  const { dark: darkGroup, ...rest } = json
  const tokens: FlatToken[] = []
  flatten(rest, [], undefined, tokens)
  const all: FlatToken[] = [...tokens]
  if (isObj(darkGroup)) flatten(darkGroup, ['dark'], undefined, all)
  const byPath = new Map(all.map((t) => [t.path, t]))

  const find = (pred: (t: FlatToken) => boolean) => {
    const t = tokens.find(pred)
    return t === undefined ? undefined : resolveAlias(t.value, byPath)
  }
  const theme: ClearedByTheme = { colors: colorsFrom(tokens, byPath) }
  theme.radius = dim(find((t) => /radius/.test(t.path) && /(^|[._-])(default|base|md|medium|sm)$|radius$/.test(t.path)))
  const font = find((t) => t.type === 'fontFamily' || /font[-_.]?family/.test(t.path))
  theme.fontFamily = Array.isArray(font) ? font.map((f) => (typeof f === 'string' && /\s/.test(f) ? `"${f}"` : f)).join(', ') : typeof font === 'string' ? font : undefined
  theme.fontSize = dim(find((t) => /font[-_.]?size/.test(t.path) && /(base|body|md|medium|default)$/.test(t.path)))
  const space = (names: string) => dim(find((t) => /(spacing|space)/.test(t.path) && new RegExp(`[._-](${names})$`).test(t.path)))
  theme.spacing = { xs: space('xs|1'), sm: space('sm|2'), md: space('md|3'), lg: space('lg|5') }
  theme.shadow = shadowString(find((t) => t.type === 'shadow' || /shadow/.test(t.path)))
  if (isObj(darkGroup)) {
    const darkTokens = all.filter((t) => t.path.startsWith('dark.')).map((t) => ({ ...t, path: t.path.slice('dark.'.length) }))
    const dc = colorsFrom(darkTokens, byPath)
    if (Object.keys(dc).length > 0) theme.dark = { colors: dc }
  }
  return sanitizeTheme(theme)
}
