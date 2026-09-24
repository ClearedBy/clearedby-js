'use client'

import {
  ApprovalQueue,
  ClearedByProvider,
  ReviewPanel,
  RulesSummary,
  type ClassNames,
  type ClearedByProviderProps,
  type ClearedByTheme,
  type UiBadgeProps,
  type UiButtonProps,
} from '@clearedby/react'
import { useState } from 'react'

// ---- Three ways to make it look like your app ------------------------------------

// (1) Theme tokens as data. Usually stored once on the server
// (PATCH /v1/partner/settings {theme}, or `npx @clearedby/react theme --from
// globals.css --push`) and fetched automatically; passing `theme` overrides it.
const BRAND_THEME: ClearedByTheme = {
  colors: {
    primary: '#0f766e',
    primaryText: '#ffffff',
    surface: '#ffffff',
    surfaceAlt: '#f0fdfa',
    border: '#cce7e3',
    text: '#0b1f1d',
    mutedText: '#4b635f',
    danger: '#be123c',
  },
  radius: '14px',
  fontFamily: 'Georgia, "Times New Roman", serif',
  shadow: '0 1px 2px rgba(15, 118, 110, 0.12)',
  dark: { colors: { surface: '#0b1f1d', surfaceAlt: '#12302c', border: '#1f4a44', text: '#e6fffb', mutedText: '#9cc9c2' } },
}

// (2) + (3) Your own classes (e.g. Tailwind utilities) with the default CSS
// switched off, and your design system's own Button and Badge.
const DS_CLASSES: Partial<ClassNames> = {
  root: 'ds-stack',
  heading: 'ds-h2',
  subheading: 'ds-h3',
  card: 'ds-card',
  cardSelected: 'ds-card-active',
  cardTitle: 'ds-eyebrow',
  cardMeta: 'ds-muted',
  list: 'ds-stack',
  hint: 'ds-muted',
  status: 'ds-muted',
  section: 'ds-section',
  table: 'ds-table',
  kv: 'ds-kv',
  kvTerm: 'ds-muted',
  textarea: 'ds-input',
  input: 'ds-input',
  select: 'ds-input',
  buttonRow: 'ds-row',
  evidenceGroup: 'ds-card',
  error: 'ds-error',
  success: 'ds-success',
}

function DsButton({ variant, className: _ignored, ...rest }: UiButtonProps) {
  return <button {...rest} className={`ds-btn ds-btn-${variant}`} />
}
function DsBadge({ tone, children }: UiBadgeProps) {
  return <span className={`ds-pill ds-pill-${tone}`}>{children}</span>
}

type Look = 'inherit' | 'brand' | 'custom'

const LOOKS: Record<Look, { label: string; props: Partial<ClearedByProviderProps> }> = {
  inherit: { label: 'Default (inherits this page)', props: {} },
  brand: { label: 'Brand theme (tokens)', props: { theme: BRAND_THEME } },
  custom: { label: 'Own classes + components', props: { unstyled: true, classNames: DS_CLASSES, components: { Button: DsButton, Badge: DsBadge } } },
}

export function Approvals({ subjects, me }: { subjects: string[]; me: string }) {
  const [tab, setTab] = useState<'waiting' | 'done' | 'rules'>('waiting')
  const [selected, setSelected] = useState<string | null>(null)
  const [look, setLook] = useState<Look>('inherit')

  return (
    <ClearedByProvider basePath="/api/clearedby" {...LOOKS[look].props}>
      <div className="shell">
        <div className="topbar">
          <h1>Acme Outdoor · Approvals</h1>
          <div className="controls">
            <label>
              Look{' '}
              <select value={look} onChange={(e) => setLook(e.target.value as Look)}>
                {(Object.keys(LOOKS) as Look[]).map((k) => <option key={k} value={k}>{LOOKS[k].label}</option>)}
              </select>
            </label>
            {subjects.length > 1 ? (
              <label>
                Signed in as{' '}
                <select
                  value={me}
                  onChange={(e) => {
                    document.cookie = `demo_subject=${encodeURIComponent(e.target.value)}; path=/; samesite=lax`
                    location.reload()
                  }}
                >
                  {subjects.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>
            ) : null}
          </div>
        </div>

        <div className="tabs" role="tablist">
          {(['waiting', 'done', 'rules'] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} onClick={() => { setTab(t); setSelected(null) }}>
              {t === 'waiting' ? 'Waiting for you' : t === 'done' ? 'Decided' : 'Your approval rules'}
            </button>
          ))}
        </div>

        {tab === 'rules' ? (
          <div className="panel"><RulesSummary /></div>
        ) : (
          <div className="columns">
            <div className="panel">
              <ApprovalQueue
                status={tab === 'waiting' ? ['pending', 'escalated'] : ['cleared', 'rejected', 'sent_back', 'expired', 'revoked']}
                title={tab === 'waiting' ? undefined : 'Decided'}
                selectedId={selected}
                onSelect={(item) => setSelected(item.id)}
              />
            </div>
            <div className="panel">
              {selected ? <ReviewPanel id={selected} /> : <p className="empty">Pick something from the list.</p>}
            </div>
          </div>
        )}
      </div>
    </ClearedByProvider>
  )
}
