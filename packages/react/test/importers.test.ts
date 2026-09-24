import { describe, expect, it } from 'vitest'
import { fromDesignTokens, fromShadcn, fromTailwind, parseCssVariables } from '../src/theme-import'

const SHADCN_V3 = `
@tailwind base;
@layer base {
  :root {
    --background: 0 0% 100%;
    --foreground: 222.2 84% 4.9%;
    --card: 0 0% 100%;
    --primary: 262.1 83.3% 57.8%;
    --primary-foreground: 210 20% 98%;
    --muted: 220 14.3% 95.9%;
    --muted-foreground: 220 8.9% 46.1%;
    --destructive: 0 84.2% 60.2%;
    --border: 220 13% 91%;
    --radius: 0.75rem;
  }
  .dark {
    --background: 224 71.4% 4.1%;
    --foreground: 210 20% 98%;
    --primary: 263.4 70% 50.4%;
    /* comment */
  }
}`

const SHADCN_V4 = `
:root {
  --radius: 0.625rem;
  --background: oklch(1 0 0);
  --foreground: oklch(0.145 0 0);
  --primary: oklch(0.205 0 0);
  --primary-foreground: oklch(0.985 0 0);
  --border: oklch(0.922 0 0);
  --destructive: oklch(0.577 0.245 27.325);
}
.dark { --background: oklch(0.145 0 0); --primary: oklch(0.922 0 0); }`

describe('fromShadcn', () => {
  it('maps shadcn v3 HSL channels to hsl() tokens, with the dark variant', () => {
    expect(fromShadcn(SHADCN_V3)).toEqual({
      colors: {
        primary: 'hsl(262.1 83.3% 57.8%)',
        primaryText: 'hsl(210 20% 98%)',
        surface: 'hsl(0 0% 100%)',
        surfaceAlt: 'hsl(220 14.3% 95.9%)',
        border: 'hsl(220 13% 91%)',
        text: 'hsl(222.2 84% 4.9%)',
        mutedText: 'hsl(220 8.9% 46.1%)',
        danger: 'hsl(0 84.2% 60.2%)',
      },
      radius: '0.75rem',
      dark: { colors: { primary: 'hsl(263.4 70% 50.4%)', surface: 'hsl(224 71.4% 4.1%)', text: 'hsl(210 20% 98%)' } },
    })
  })

  it('keeps shadcn v4 oklch() colours as they are', () => {
    const t = fromShadcn(SHADCN_V4)
    expect(t?.colors?.primary).toBe('oklch(0.205 0 0)')
    expect(t?.colors?.danger).toBe('oklch(0.577 0.245 27.325)')
    expect(t?.radius).toBe('0.625rem')
    expect(t?.dark?.colors?.surface).toBe('oklch(0.145 0 0)')
  })

  it('accepts a variables map, and an element’s computed style', () => {
    expect(fromShadcn({ '--primary': '221 83% 53%', '--radius': '6px' })).toEqual({ colors: { primary: 'hsl(221 83% 53%)' }, radius: '6px' })
    const el = document.createElement('div')
    el.style.setProperty('--primary', '10 80% 50%')
    el.style.setProperty('--border', '#e5e7eb')
    document.body.appendChild(el)
    expect(fromShadcn(el)?.colors).toEqual({ primary: 'hsl(10 80% 50%)', border: '#e5e7eb' })
  })

  it('parses :root and .dark blocks only', () => {
    const v = parseCssVariables('.btn{--primary: red} :root{--primary: blue} html.dark{--primary: black}')
    expect(v).toEqual({ light: { '--primary': 'blue' }, dark: { '--primary': 'black' } })
  })
})

describe('fromTailwind', () => {
  it('maps semantic colours first, then the palette, plus radius / font / spacing / shadow', () => {
    const resolved = {
      theme: {
        colors: {
          white: '#ffffff',
          primary: { DEFAULT: '#7c3aed', foreground: '#fafafa' },
          gray: { 100: '#f3f4f6', 200: '#e5e7eb', 500: '#6b7280', 900: '#111827' },
          green: { 600: '#16a34a' },
          amber: { 600: '#d97706' },
          red: { 600: '#dc2626' },
        },
        borderRadius: { DEFAULT: '0.25rem', lg: '0.5rem' },
        fontFamily: { sans: ['Inter var', 'system-ui', 'sans-serif'] },
        fontSize: { base: ['1rem', { lineHeight: '1.5rem' }] },
        spacing: { 1: '0.25rem', 2: '0.5rem', 3: '0.75rem', 5: '1.25rem' },
        boxShadow: { sm: '0 1px 2px 0 rgb(0 0 0 / 0.05)' },
      },
    }
    expect(fromTailwind(resolved)).toEqual({
      colors: {
        primary: '#7c3aed',
        primaryText: '#fafafa',
        surface: '#ffffff',
        surfaceAlt: '#f3f4f6',
        border: '#e5e7eb',
        text: '#111827',
        mutedText: '#6b7280',
        success: '#16a34a',
        warning: '#d97706',
        danger: '#dc2626',
      },
      radius: '0.25rem',
      fontFamily: '"Inter var", system-ui, sans-serif',
      fontSize: '1rem',
      spacing: { xs: '0.25rem', sm: '0.5rem', md: '0.75rem', lg: '1.25rem' },
      shadow: '0 1px 2px 0 rgb(0 0 0 / 0.05)',
    })
  })

  it('falls back to the default palette and drops var() references', () => {
    const t = fromTailwind({ theme: { colors: { primary: 'hsl(var(--primary))', blue: { 600: '#2563eb' }, border: 'hsl(var(--border))' } } })
    // primary is a var() reference: dropped (use fromShadcn with globals.css instead)
    expect(t?.colors?.primary).toBeUndefined()
    expect(t?.colors?.border).toBeUndefined()
    expect(fromTailwind({ theme: { colors: { blue: { 500: '#3b82f6', 600: '#2563eb' } } } })?.colors?.primary).toBe('#2563eb')
  })
})

describe('fromDesignTokens', () => {
  it('maps W3C design tokens by name, resolving aliases, with a dark group', () => {
    const tokens = {
      color: {
        $type: 'color',
        brand: { 500: { $value: '#0f766e' } },
        primary: { $value: '{color.brand.500}' },
        'on-primary': { $value: '#ffffff' },
        background: { $value: '#fafafa' },
        'background-subtle': { $value: '#f4f4f5' },
        border: { $value: '#e4e4e7' },
        text: { default: { $value: '#18181b' }, muted: { $value: '#71717a' } },
        success: { $value: '#15803d' },
        warning: { $value: '#b45309' },
        error: { $value: '#b91c1c' },
      },
      radius: { md: { $type: 'dimension', $value: '10px' } },
      font: { family: { base: { $type: 'fontFamily', $value: ['Söhne', 'Helvetica', 'sans-serif'] } }, size: { base: { $type: 'dimension', $value: { value: 15, unit: 'px' } } } },
      spacing: { $type: 'dimension', xs: { $value: '4px' }, sm: { $value: '8px' }, md: { $value: '12px' }, lg: { $value: '20px' } },
      shadow: { card: { $type: 'shadow', $value: { offsetX: '0px', offsetY: '1px', blur: '3px', spread: '0px', color: 'rgba(0,0,0,0.1)' } } },
      dark: { color: { $type: 'color', background: { $value: '#09090b' }, text: { default: { $value: '#fafafa' } } } },
    }
    expect(fromDesignTokens(tokens)).toEqual({
      colors: {
        primary: '#0f766e',
        primaryText: '#ffffff',
        surface: '#fafafa',
        surfaceAlt: '#f4f4f5',
        border: '#e4e4e7',
        text: '#18181b',
        mutedText: '#71717a',
        success: '#15803d',
        warning: '#b45309',
        danger: '#b91c1c',
      },
      radius: '10px',
      fontFamily: 'Söhne, Helvetica, sans-serif',
      fontSize: '15px',
      spacing: { xs: '4px', sm: '8px', md: '12px', lg: '20px' },
      shadow: '0px 1px 3px 0px rgba(0,0,0,0.1)',
      dark: { colors: { surface: '#09090b', text: '#fafafa' } },
    })
  })

  it('returns null for nothing usable', () => {
    expect(fromDesignTokens({ nothing: { here: 1 } })).toBeNull()
    expect(fromDesignTokens('x')).toBeNull()
  })
})
