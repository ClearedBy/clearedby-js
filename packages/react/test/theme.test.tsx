import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ApprovalQueue, ClearedByProvider, sanitizeTheme, themeCss, themeToCssVars } from '../src'
import { fakeProxy } from './fixtures'

const styleText = () => Array.from(document.querySelectorAll('style[data-cb-theme-style]')).map((s) => s.textContent ?? '').join('\n')

describe('theme', () => {
  it('the provider fetches the stored theme and applies it as --cb-* variables on its scope', async () => {
    const api = fakeProxy({
      'GET /theme': () => ({ theme: { colors: { primary: '#6b3fd4', surface: '#ffffff' }, radius: '12px', dark: { colors: { surface: '#0b0b0f' } } } }),
      'GET /items': () => ({ items: [], next_cursor: null }),
    })
    const { container } = render(<ClearedByProvider fetch={api.fetch} pollInterval={0}><ApprovalQueue /></ClearedByProvider>)
    await waitFor(() => expect(styleText()).toContain('--cb-color-primary:#6b3fd4'))
    const scope = container.querySelector('[data-cb-theme]')!
    const id = scope.getAttribute('data-cb-theme')!
    const css = styleText()
    expect(css).toContain(`[data-cb-theme="${id}"]{`)
    expect(css).toContain('--cb-radius:12px')
    expect(css).toContain(`@media (prefers-color-scheme: dark){[data-cb-theme="${id}"]{--cb-color-surface:#0b0b0f;}}`)
    expect(api.calls.some((c) => c.path === '/theme')).toBe(true)
    expect(await screen.findByText('Nothing is waiting for you.')).toBeTruthy()
  })

  it('the theme prop overrides the fetched theme, token by token', async () => {
    const api = fakeProxy({
      'GET /theme': () => ({ theme: { colors: { primary: '#6b3fd4', danger: '#aa0000' } } }),
      'GET /items': () => ({ items: [], next_cursor: null }),
    })
    render(<ClearedByProvider fetch={api.fetch} pollInterval={0} theme={{ colors: { primary: '#0f766e' } }}><ApprovalQueue /></ClearedByProvider>)
    await waitFor(() => expect(styleText()).toContain('--cb-color-danger:#aa0000'))
    expect(styleText()).toContain('--cb-color-primary:#0f766e')
    expect(styleText()).not.toContain('#6b3fd4')
  })

  it('a fetched theme with injected CSS is dropped, never applied', async () => {
    const api = fakeProxy({
      'GET /theme': () => ({ theme: { colors: { primary: 'red;}body{display:none', danger: 'url(https://x/y.png)', success: '#00aa00' } } }),
      'GET /items': () => ({ items: [], next_cursor: null }),
    })
    render(<ClearedByProvider fetch={api.fetch} pollInterval={0}><ApprovalQueue /></ClearedByProvider>)
    await waitFor(() => expect(styleText()).toContain('--cb-color-success:#00aa00'))
    expect(styleText()).not.toMatch(/display:none|url\(/)
  })

  it('works without a stored theme (404 or none) and with fetchTheme off', async () => {
    const api = fakeProxy({ 'GET /items': () => ({ items: [], next_cursor: null }) })
    render(<ClearedByProvider fetch={api.fetch} pollInterval={0} fetchTheme={false}><ApprovalQueue /></ClearedByProvider>)
    expect(await screen.findByText('Nothing is waiting for you.')).toBeTruthy()
    expect(api.calls.some((c) => c.path === '/theme')).toBe(false)
    expect(styleText()).toBe('')
  })

  it('colorScheme: dark forces the dark tokens; class follows a .dark ancestor', () => {
    const t = { colors: { surface: '#fff', text: '#111' }, dark: { colors: { surface: '#000' } } }
    expect(themeCss(t, 's1', 'dark')).toBe('[data-cb-theme="s1"]{--cb-color-surface:#000;--cb-color-text:#111;}')
    expect(themeCss(t, 's1', 'class')).toContain('.dark [data-cb-theme="s1"]{--cb-color-surface:#000;}')
    expect(themeCss(t, 's1', 'light')).not.toContain('#000')
    expect(themeCss(t, 'bad"]{', 'auto')).toBe('')
  })

  it('sanitizeTheme keeps only real colours / lengths / fonts / shadows', () => {
    expect(sanitizeTheme({
      colors: { primary: 'oklch(0.6 0.2 280)', text: 'expression(x)', border: 'var(--x)', surface: '#fff' },
      radius: '1rem', fontSize: '15px;', fontFamily: 'Inter, "Helvetica Neue", sans-serif', spacing: { sm: '8px', md: 'calc(1px)' },
      shadow: '0 1px 2px rgba(0,0,0,.1)', extra: 'nope',
    })).toEqual({
      colors: { primary: 'oklch(0.6 0.2 280)', surface: '#fff' },
      radius: '1rem',
      fontFamily: 'Inter, "Helvetica Neue", sans-serif',
      spacing: { sm: '8px' },
      shadow: '0 1px 2px rgba(0,0,0,.1)',
    })
    expect(themeToCssVars({ spacing: { lg: '24px' }, fontSize: '14px' })).toEqual({ '--cb-space-lg': '24px', '--cb-font-size': '14px' })
    expect(sanitizeTheme('nope')).toBeNull()
  })
})
