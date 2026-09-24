# @clearedby/react

A drop-in approval experience for your own React app. Your merchants see what
your assistant wants to do, in plain English, and approve, decline, send it back
or hand it to someone else, without leaving your product. They never see
ClearedBy.

- **Headless hooks** for a fully custom UI, and **default components** you can
  drop in: `ApprovalQueue`, `ApprovalCard`, `ReviewPanel`, `DecisionBar`,
  `RulesSummary`, `History`, `CancelButton`.
- **Looks like your app.** It inherits your font and colours. Theme it with
  tokens, per-part classes (Tailwind, CSS modules…), or your own design-system
  components. See [Styling](#styling).
- **Safe by construction.** The browser only talks to *your* server (the
  partner proxy from `@clearedby/sdk/partner-proxy`). The partner key and every
  ClearedBy token stay on your server.
- React 18+, no other runtime dependencies, ESM + types, tree-shakeable.

```bash
npm i @clearedby/react @clearedby/sdk
```

## Quick start (about 20 lines)

**1. Server: one route.** Next.js App Router shown; `expressHandler(proxy)` works for Express.

```ts
// app/api/clearedby/[...path]/route.ts
import { createPartnerProxy } from '@clearedby/sdk/partner-proxy'
import { getSession } from '@/lib/auth' // yours

const proxy = createPartnerProxy({
  partnerKey: process.env.CLEAREDBY_PARTNER_KEY!,
  // Who is asking, from YOUR session. The org and person come only from here.
  resolveUser: async (req) => {
    const s = await getSession(req)
    return s ? { org_id: s.merchant.clearedbyOrgId, external_subject: s.user.id } : null
  },
})
export const GET = proxy.handle, POST = proxy.handle, PUT = proxy.handle
```

**2. Browser: provider + queue + panel.**

```tsx
'use client'
import { ClearedByProvider, ApprovalQueue, ReviewPanel } from '@clearedby/react'
import '@clearedby/react/styles.css'
import { useState } from 'react'

export function Approvals() {
  const [id, setId] = useState<string | null>(null)
  return (
    <ClearedByProvider basePath="/api/clearedby">
      <ApprovalQueue onSelect={(item) => setId(item.id)} selectedId={id} />
      {id && <ReviewPanel id={id} />}
    </ClearedByProvider>
  )
}
```

That's it. A full, runnable app is in
[`examples/partner-approvals-next`](../../examples/partner-approvals-next).

## How it stays safe

```
browser ──(your session cookie)──▶ your server: createPartnerProxy ──(partner key / short-lived tokens)──▶ ClearedBy
```

- The proxy serves a **fixed** list of routes: queue, item, history,
  permissions, decide, cancel, rules (read / change / accept) and theme.
  Anything else is `404`. Nothing is forwarded blindly.
- For each request it calls your `resolveUser(req)` (`401` when it returns
  `null`). The **org and person always come from there**: an `org_id` or
  `reviewer` in the request is ignored or refused.
- Reads use a **read-only token** for that person (reusable for up to 15
  minutes, cached on your server, can never decide). Each decision uses a
  fresh **single-use decision token** pinned to that item. ClearedBy checks
  the person's authority itself, every time.
- Responses are scrubbed: no tokens, no keys, no signed receipts.
- Writes must be same-origin JSON (CSRF defence). Add other origins with
  `allowedOrigins`.

## Components

| Component | What it shows |
| --- | --- |
| `<ApprovalQueue status filter onSelect selectedId />` | What's waiting for this person, newest first. Up/Down arrows move, Enter opens. `status` defaults to waiting items; pass e.g. `['cleared','rejected']` for a "Decided" tab. |
| `<ApprovalCard item />` | One entry: "Refund £120.00 on order #6001". |
| `<ReviewPanel id />` | The action in plain English (Shopify actions get their catalogue names), why the assistant wants it, a before/after table for batches (paged, 50 rows at a time, with a summary: fine for 3,000 items), the facts grouped as **Verified by \<you\>** / **Checked automatically** / **Agent says**, the decision buttons, "Cancel before it runs" and the history. |
| `<DecisionBar id />` | Only the buttons this person may press: **Approve**, **Decline**, **Send back with a note**, **Ask someone else**. Declining and sending back ask for a short note first. |
| `<RulesSummary />` | "Your approval rules" in plain English, **Looks good** / **Adjust**, simple controls (including spot-checks with "How often"), and the owner's OK when a change makes the rules less strict. |
| `<History id />` | The story: asked, sent back and revised, approved, carried out, cancelled, undone. |
| `<CancelButton id />` | "Cancel before it runs" on an approved change that hasn't happened yet. |

All wording is written for merchants (no "policy", no vendor names) and every
string can be changed:

```tsx
<ClearedByProvider labels={{ queueTitle: 'Needs a look', decisions: { clear: 'Yes, go ahead' } }}>
```

## Hooks (build your own UI)

```ts
useApprovalQueue({ status, filter: { actionPrefix, batchId }, limit }) // { items, loading, error, hasMore, loadMore, revalidate }
useApproval(id)          // { data, error, loading, revalidate }
usePermissions(id)       // { data: { can, cannot, reason_required, ... } }
useHistory(id)           // { data: events[] }
useDecide(id)            // { decide(decision, { reason, escalateTo }), pending, error, result }
useRevoke(id)            // { revoke(reason), ... }
useRules()               // { data: { summary, settings, pending_proposal, viewer } }
useRulesProposal()       // { propose(settings), accept(proposalId), ... }
useRevalidate()          // (prefix?) => refresh open views now
```

`decide('reject' | 'send_back')` without a reason (4+ characters) is refused
before anything is sent.

## Live updates

Open views refresh every 15 seconds while the tab is visible, pause while it is
hidden, refresh as soon as it's visible again, and back off (up to 5 minutes)
after errors. Change it with `pollInterval` (ms; `0` turns polling off).

For instant updates, push from your backend. Subscribe to ClearedBy's
lifecycle webhooks (`decision.pending`, `decision.cleared`, …) with the org's
key, forward them to the browser however you already do (WebSocket, SSE,
Pusher…), and call `revalidate`:

```tsx
const revalidate = useRevalidate()
useEffect(() => socket.on('approvals-changed', () => revalidate()), [])
```

## Styling

Pick any level; they combine.

### (a) Theme tokens

Import `@clearedby/react/styles.css`. It only uses `cb-*` classes (no element
selectors, no resets, nothing global), inherits your font and text colour, and
reads every colour, radius, space, font size and shadow from a CSS variable
with neutral, dark-mode-friendly fallbacks:

```css
:root {
  --cb-color-primary: #6b3fd4;   --cb-color-primary-text: #fff;
  --cb-color-surface: #fff;      --cb-color-surface-alt: #f6f5fb;
  --cb-color-border: #e4e1ee;    --cb-color-text: inherit;   --cb-color-muted: #6b6780;
  --cb-color-success: #15803d;   --cb-color-warning: #b45309; --cb-color-danger: #dc2626;
  --cb-radius: 10px;  --cb-font: inherit;  --cb-font-size: 15px;  --cb-shadow: none;
  --cb-space-xs: 4px; --cb-space-sm: 8px;  --cb-space-md: 12px;   --cb-space-lg: 20px;
}
.dark { --cb-color-surface: #16151c; --cb-color-border: #2a2833; }
```

Or pass the same tokens as data (see [Specify your theme](#specify-your-theme)).

### (b) Per-part classes, or no default CSS at all

Every component takes `className` and a `classNames` map of its parts; the
provider takes a `classNames` map for everything. `unstyled` drops every default
`cb-*` class, so Tailwind or shadcn users style everything themselves:

```tsx
<ClearedByProvider
  unstyled
  classNames={{
    card: 'rounded-xl border p-4 text-left hover:border-primary',
    cardSelected: 'border-primary ring-2 ring-primary/20',
    heading: 'text-lg font-semibold',
    button: 'inline-flex h-9 items-center rounded-md px-4 text-sm font-medium',
    primaryButton: 'bg-primary text-primary-foreground',
    dangerButton: 'bg-destructive text-destructive-foreground',
    input: 'h-9 rounded-md border px-3', textarea: 'rounded-md border p-3',
    badge: 'rounded-full px-2 text-xs', table: 'w-full text-sm',
  }}
>
```

All parts: `root heading subheading text hint status success error warning list
listItem card cardSelected cardTop cardTitle cardSentence cardMeta badge
badgeWaiting badgeOk badgeBad badgeWarn badgeMuted button primaryButton
secondaryButton dangerButton ghostButton link buttonRow form field label input
textarea select checkbox checkboxLabel header kicker meta section note kv kvRow
kvTerm kvValue tableWrap table tableHeadCell tableRow tableRowHeader tableCell
pager evidence evidenceGroup evidenceVerified evidenceComputed evidenceAgent
evidenceBadge evidenceItem evidenceLabel evidenceValue evidenceList callout diff
diffBefore diffAfter timeline timelineItem timelineRevision timelineTime dialog
dialogTitle` (typed as `ClassNames`).

### (c) Your own components

Render buttons, inputs, selects, badges and dialogs with your design system's
components. Each gets simple props (`variant`, `tone`, `open`/`onClose`…) plus
the usual HTML attributes:

```tsx
import { Button } from '@/components/ui/button'   // shadcn
import { Badge } from '@/components/ui/badge'
import type { UiButtonProps, UiBadgeProps, UiDialogProps } from '@clearedby/react'

const components = {
  Button: ({ variant, ...p }: UiButtonProps) =>
    <Button variant={variant === 'danger' ? 'destructive' : variant === 'primary' ? 'default' : variant} {...p} />,
  Badge: ({ tone, children }: UiBadgeProps) => <Badge variant={tone === 'bad' ? 'destructive' : 'secondary'}>{children}</Badge>,
  Dialog: ({ open, onClose, title, titleId, children }: UiDialogProps) => (
    <MyDialog open={open} onOpenChange={(o) => !o && onClose()}><h2 id={titleId}>{title}</h2>{children}</MyDialog>
  ),
}

<ClearedByProvider components={components}>
```

The defaults are plain, accessible elements. And the [hooks](#hooks-build-your-own-ui)
are always there for a completely custom UI.

## Specify your theme

Your merchants' approval UI can pick up your look **without anyone writing CSS**.
A theme is data (`ClearedByTheme`):

```ts
interface ClearedByTheme {
  colors?: {
    primary?: string; primaryText?: string; surface?: string; surfaceAlt?: string; border?: string
    text?: string; mutedText?: string; success?: string; warning?: string; danger?: string
  }
  radius?: string          // '8px', '0.5rem'
  fontFamily?: string      // "Inter, system-ui, sans-serif"
  fontSize?: string        // '15px'
  spacing?: { xs?: string; sm?: string; md?: string; lg?: string }
  shadow?: string          // '0 1px 2px rgba(0,0,0,.08)'
  dark?: { colors?: ClearedByTheme['colors']; shadow?: string }
}
```

Only plain CSS colours (`#hex`, `rgb()`, `hsl()`, `oklch()`, names), lengths
(`px`, `rem`, `em`, `%`), font lists and shadows are accepted. `url()`,
`var()`, `expression()`, `;`, `{`, `}` and friends are refused, so a theme can
never inject CSS.

**Option 1: store it once, it's applied everywhere.** Save it with your partner
key; `ClearedByProvider` fetches it through your proxy (`GET /theme`) and applies
it. A per-merchant override wins token by token.

```ts
import { ClearedByPartner } from '@clearedby/sdk'
const partner = new ClearedByPartner({ partnerKey: process.env.CLEAREDBY_PARTNER_KEY! })
await partner.updateSettings({ theme: { colors: { primary: '#6b3fd4' }, radius: '10px' } })
// one merchant: PATCH /v1/partner/orgs/:org_id { "theme": { ... } }
```

**Option 2: generate it from your design system** with the importers (pure
functions) or the CLI:

```ts
import { fromShadcn, fromTailwind, fromDesignTokens } from '@clearedby/react/theme'

fromShadcn(globalsCssText)            // shadcn/ui CSS variables (v3 HSL channels or v4 oklch), incl. .dark
fromShadcn(document.documentElement)  // ...or read them live in the browser
fromTailwind(resolveConfig(tailwindConfig))
fromDesignTokens(w3cTokensJson)       // W3C Design Tokens (DTCG), aliases resolved
```

```bash
npx @clearedby/react theme --from app/globals.css              # prints the theme JSON
npx @clearedby/react theme --from tailwind.config.js --push    # ...and stores it (CLEAREDBY_PARTNER_KEY)
npx @clearedby/react theme --from tokens.json --push --org 01K...   # for one merchant
```

**Option 3: pass it in code.** `<ClearedByProvider theme={myTheme}>` overrides
the stored theme token by token. `colorScheme` picks when the `dark` tokens
apply: `'auto'` (the OS setting, default), `'class'` (a `.dark` ancestor, the
shadcn/Tailwind convention), `'light'` or `'dark'`. `fetchTheme={false}` skips
the fetch.

### Let your AI coding agent do it

Paste this into Claude Code, Cursor or similar, in your app's repo:

> Read our design system (the Tailwind config, `globals.css` / CSS variables,
> or design-token files) and produce a JSON object matching this TypeScript
> type, choosing the values our app actually uses for buttons, cards, borders,
> body text, muted text, success/warning/error states, corner radius, font and
> spacing. Use only literal CSS values: hex / `rgb()` / `hsl()` / `oklch()`
> colours, `px` / `rem` lengths, a font-family list and a box-shadow. No
> `var()`, no `url()`. Include a `dark` block if we support dark mode. Output
> only the JSON.
>
> ```ts
> interface ClearedByTheme {
>   colors?: { primary?: string; primaryText?: string; surface?: string; surfaceAlt?: string; border?: string;
>              text?: string; mutedText?: string; success?: string; warning?: string; danger?: string }
>   radius?: string; fontFamily?: string; fontSize?: string
>   spacing?: { xs?: string; sm?: string; md?: string; lg?: string }
>   shadow?: string
>   dark?: { colors?: ClearedByTheme['colors']; shadow?: string }
> }
> ```
>
> Then save it with `npx @clearedby/react theme --from clearedby-theme.json --push`.

## Accessibility

Real buttons, labels and headings; `aria-current` on the open card; arrow-key
navigation in the queue; `role="status"` / `role="alert"` for outcomes and
errors; required notes are `aria-required` and flagged `aria-invalid` with a
described error; focus moves to the note box when it opens and `Escape` closes
it; badges and evidence groups are labelled, not colour-only.
