// npx @clearedby/react theme --from <tailwind.config.js | globals.css | tokens.json> [--push] [--org <org_id>]
// (bin/clearedby-react.js → main())
//
// Prints a ClearedByTheme (JSON) built from your design system, and with
// --push stores it: account-wide (PATCH /v1/partner/settings {theme}) or for
// one merchant org (--org <id>: PATCH /v1/partner/orgs/:id {theme}), using
// CLEAREDBY_PARTNER_KEY from the environment. A thin wrapper over
// fromShadcn / fromTailwind / fromDesignTokens.

import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { fromDesignTokens, fromShadcn, fromTailwind } from './theme-import.js'
import { sanitizeTheme, type ClearedByTheme } from './theme.js'

export interface CliDeps {
  readFile: (file: string) => Promise<string>
  importModule: (file: string) => Promise<unknown>
  /** Resolve a Tailwind 3 config (tailwindcss/resolveConfig), when available. */
  resolveTailwind: (config: unknown, cwd: string) => Promise<unknown>
  fetch: typeof fetch
  env: Record<string, string | undefined>
  cwd: string
  out: (s: string) => void
  err: (s: string) => void
}

const USAGE = `Usage: clearedby-react theme --from <file> [--push] [--org <org_id>] [--base-url <url>]

  --from      tailwind.config.{js,cjs,mjs,ts} | globals.css (shadcn) | tokens.json (W3C design tokens)
              | a resolved Tailwind config dumped to .json | an existing ClearedByTheme .json
  --push      store it with your partner key (CLEAREDBY_PARTNER_KEY)
  --org       store it for one merchant org instead of your whole account
  --base-url  default: CLEAREDBY_BASE_URL or https://app.clearedby.com`

function parseArgs(argv: string[]): { cmd?: string; from?: string; push: boolean; org?: string; baseUrl?: string; help: boolean } {
  const out: { cmd?: string; from?: string; push: boolean; org?: string; baseUrl?: string; help: boolean } = { push: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--from') out.from = argv[++i]
    else if (a === '--org') out.org = argv[++i]
    else if (a === '--base-url') out.baseUrl = argv[++i]
    else if (a === '--push') out.push = true
    else if (a === '--help' || a === '-h') out.help = true
    else if (out.cmd === undefined && a !== undefined && !a.startsWith('-')) out.cmd = a
  }
  return out
}

const hasDollarValue = (v: unknown): boolean =>
  v !== null && typeof v === 'object' && (Object.prototype.hasOwnProperty.call(v, '$value') || Object.values(v as object).some(hasDollarValue))

/** Build a theme from one file. Throws with a readable message. */
export async function themeFromFile(file: string, deps: Pick<CliDeps, 'readFile' | 'importModule' | 'resolveTailwind' | 'cwd'>): Promise<ClearedByTheme | null> {
  const ext = path.extname(file).toLowerCase()
  if (ext === '.css') return fromShadcn(await deps.readFile(file))
  if (ext === '.json') {
    const json = JSON.parse(await deps.readFile(file)) as Record<string, unknown>
    if (hasDollarValue(json)) return fromDesignTokens(json)
    if (json.theme !== undefined || (json.colors !== undefined && typeof (json.colors as Record<string, unknown>).primary !== 'string')) {
      return fromTailwind(json)
    }
    return sanitizeTheme(json)
  }
  if (['.js', '.cjs', '.mjs', '.ts', '.mts', '.cts'].includes(ext)) {
    let mod: unknown
    try {
      mod = await deps.importModule(path.resolve(deps.cwd, file))
    } catch (e) {
      throw new Error(`could not load ${file}: ${(e as Error).message}${ext.endsWith('ts') ? ' (for a TypeScript config run with `npx tsx`, or dump the resolved config to JSON)' : ''}`)
    }
    const config = (mod as { default?: unknown }).default ?? mod
    return fromTailwind(await deps.resolveTailwind(config, deps.cwd))
  }
  throw new Error(`don't know how to read ${file} (expected .css, .json, or a tailwind config)`)
}

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const args = parseArgs(argv)
  if (args.help || args.cmd !== 'theme' || args.from === undefined) {
    deps.err(USAGE)
    return args.help ? 0 : 1
  }
  let theme: ClearedByTheme | null
  try {
    theme = await themeFromFile(args.from, deps)
  } catch (e) {
    deps.err(`clearedby-react: ${(e as Error).message}`)
    return 1
  }
  if (theme === null) {
    deps.err('clearedby-react: no usable tokens found (values must be plain CSS colours, lengths, fonts or shadows)')
    return 1
  }
  deps.out(JSON.stringify(theme, null, 2))
  if (!args.push) return 0

  const key = deps.env.CLEAREDBY_PARTNER_KEY
  if (!key || !/^cb_partner_/.test(key)) {
    deps.err('clearedby-react: --push needs CLEAREDBY_PARTNER_KEY (a cb_partner_… key) in the environment')
    return 1
  }
  const base = (args.baseUrl ?? deps.env.CLEAREDBY_BASE_URL ?? 'https://app.clearedby.com').replace(/\/$/, '')
  const target = args.org ? `/v1/partner/orgs/${encodeURIComponent(args.org)}` : '/v1/partner/settings'
  const res = await deps.fetch(`${base}${target}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ theme }),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } }
    deps.err(`clearedby-react: push failed (${res.status}): ${body.error?.message ?? 'unknown error'}`)
    return 1
  }
  deps.err(`clearedby-react: theme saved ${args.org ? `for org ${args.org}` : 'for your account'}`)
  return 0
}

async function defaultResolveTailwind(config: unknown, cwd: string): Promise<unknown> {
  try {
    const req = createRequire(path.join(cwd, 'package.json'))
    const resolveConfig = req('tailwindcss/resolveConfig') as (c: unknown) => unknown
    return resolveConfig(config)
  } catch {
    // No Tailwind 3 installed (or Tailwind 4): use theme + theme.extend as written.
    const c = (config ?? {}) as { theme?: Record<string, unknown> & { extend?: Record<string, unknown> } }
    const { extend, ...theme } = c.theme ?? {}
    const merged: Record<string, unknown> = { ...theme }
    for (const [k, v] of Object.entries(extend ?? {})) {
      merged[k] = typeof v === 'object' && v !== null && typeof merged[k] === 'object' ? { ...(merged[k] as object), ...(v as object) } : v
    }
    return { theme: merged }
  }
}

/** Entry point for bin/clearedby-react.js. */
export function main(): void {
  void runCli(process.argv.slice(2), {
    readFile: (f) => readFile(f, 'utf8'),
    importModule: (f) => import(pathToFileURL(f).href),
    resolveTailwind: defaultResolveTailwind,
    fetch: globalThis.fetch,
    env: process.env,
    cwd: process.cwd(),
    out: (s) => process.stdout.write(`${s}\n`),
    err: (s) => process.stderr.write(`${s}\n`),
  }).then((code) => {
    process.exitCode = code
  })
}
