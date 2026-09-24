import { describe, expect, it, vi } from 'vitest'
import { runCli, type CliDeps } from '../src/cli'

function deps(files: Record<string, string>, over: Partial<CliDeps> = {}) {
  const out: string[] = []
  const err: string[] = []
  const fetch = vi.fn(async () => new Response(JSON.stringify({ theme: {} }), { status: 200 }))
  const d: CliDeps = {
    readFile: async (f) => {
      if (!(f in files)) throw new Error(`ENOENT ${f}`)
      return files[f] as string
    },
    importModule: async () => ({ default: { theme: { colors: { primary: { DEFAULT: '#7c3aed' } } } } }),
    resolveTailwind: async (c) => c,
    fetch: fetch as unknown as typeof globalThis.fetch,
    env: {},
    cwd: '/proj',
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    ...over,
  }
  return { d, out, err, fetch }
}

describe('clearedby-react theme', () => {
  it('prints a theme from shadcn globals.css', async () => {
    const { d, out } = deps({ 'globals.css': ':root{--primary: 262 83% 58%; --radius: 0.5rem}' })
    expect(await runCli(['theme', '--from', 'globals.css'], d)).toBe(0)
    expect(JSON.parse(out[0]!)).toEqual({ colors: { primary: 'hsl(262 83% 58%)' }, radius: '0.5rem' })
  })

  it('reads W3C tokens, a resolved Tailwind JSON and a tailwind.config.js', async () => {
    const tokens = deps({ 'tokens.json': JSON.stringify({ color: { primary: { $type: 'color', $value: '#0f766e' } } }) })
    expect(await runCli(['theme', '--from', 'tokens.json'], tokens.d)).toBe(0)
    expect(JSON.parse(tokens.out[0]!).colors.primary).toBe('#0f766e')

    const tw = deps({ 'tw.json': JSON.stringify({ theme: { colors: { primary: '#123456' } } }) })
    expect(await runCli(['theme', '--from', 'tw.json'], tw.d)).toBe(0)
    expect(JSON.parse(tw.out[0]!).colors.primary).toBe('#123456')

    const js = deps({})
    expect(await runCli(['theme', '--from', 'tailwind.config.js'], js.d)).toBe(0)
    expect(JSON.parse(js.out[0]!).colors.primary).toBe('#7c3aed')
  })

  it('--push PATCHes partner settings (or one org) with the key from the environment', async () => {
    const { d, fetch, err } = deps({ 'globals.css': ':root{--primary: #6b3fd4}' }, { env: { CLEAREDBY_PARTNER_KEY: 'cb_partner_abc', CLEAREDBY_BASE_URL: 'http://localhost:3000/' } })
    expect(await runCli(['theme', '--from', 'globals.css', '--push'], d)).toBe(0)
    expect(fetch).toHaveBeenCalledWith('http://localhost:3000/v1/partner/settings', expect.objectContaining({
      method: 'PATCH',
      headers: expect.objectContaining({ authorization: 'Bearer cb_partner_abc' }),
      body: JSON.stringify({ theme: { colors: { primary: '#6b3fd4' } } }),
    }))
    expect(err.at(-1)).toMatch(/saved for your account/)
    await runCli(['theme', '--from', 'globals.css', '--push', '--org', '01KORG'], d)
    expect((fetch.mock.calls.at(-1) as unknown[])[0]).toBe('http://localhost:3000/v1/partner/orgs/01KORG')
  })

  it('fails clearly: no key, nothing usable, unknown file type, a refused push', async () => {
    const noKey = deps({ 'a.css': ':root{--primary: #fff}' })
    expect(await runCli(['theme', '--from', 'a.css', '--push'], noKey.d)).toBe(1)
    expect(noKey.err.at(-1)).toMatch(/CLEAREDBY_PARTNER_KEY/)
    expect(noKey.fetch).not.toHaveBeenCalled()

    const empty = deps({ 'a.css': ':root{--primary: var(--x)}' })
    expect(await runCli(['theme', '--from', 'a.css'], empty.d)).toBe(1)

    const weird = deps({ 'a.txt': '' })
    expect(await runCli(['theme', '--from', 'a.txt'], weird.d)).toBe(1)

    const refused = deps({ 'a.css': ':root{--primary: #fff}' }, {
      env: { CLEAREDBY_PARTNER_KEY: 'cb_partner_abc' },
      fetch: (async () => new Response(JSON.stringify({ error: { message: 'bad theme' } }), { status: 400 })) as unknown as typeof fetch,
    })
    expect(await runCli(['theme', '--from', 'a.css', '--push'], refused.d)).toBe(1)
    expect(refused.err.at(-1)).toMatch(/push failed \(400\): bad theme/)

    const usage = deps({})
    expect(await runCli([], usage.d)).toBe(1)
    expect(usage.err[0]).toMatch(/Usage/)
  })
})
