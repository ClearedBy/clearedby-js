# Proof cases & evidence — complete reference

A **proof case** is the agent's argument for an action: *why it should happen, with evidence*. You attach it to a
gate call (`proof` in the SDK, the `proof`/`evidence` args in the MCP `request_clearance` tool, or a top-level
`proof` in a raw HTTP request). When the action is held for a human, the reviewer sees it as a **Proof Case panel**
with friendly **evidence cards** — and decides in seconds without leaving the dashboard.

> ClearedBy **presents** your case to a human and pins it, tamper-evident, to their decision (`context_hash`,
> folded into the signed attestation). It does **not** verify the *truth* of evidence — veracity is the reviewer's
> call; that's the whole point of routing to a human. The cards are your assertions.

The whole thing is **optional and backward-compatible** — omit `proof` and the gate still works.

---

## The `proof` object

| field | type | notes |
| --- | --- | --- |
| `reason` | string | plain-language why this should happen |
| `confidence` | number `0..1` | the agent's own confidence; shown as "agent confidence N%" |
| `recommended_outcome` | string | e.g. `approve_refund`; rendered as a "recommends ·" pill |
| `risk_flags` | string[] | what the human should weigh, e.g. `["high_value","first_order"]` |
| `evidence` | Evidence[] | typed evidence cards (below) |

*(In the SDK these are camelCase where noted — `recommendedOutcome`, `riskFlags` — and serialized for you. In raw
HTTP / MCP, use the snake_case names above.)*

---

## Evidence cards

Each item in `evidence[]` is `{ type, value }`. The **known `type`s** below render as friendly cards. **Any other
`type` falls back to a generic key/value card** — so you can always invent your own and it still shows. `value` is
parsed defensively: if its shape isn't what the card expects, it degrades to the generic card rather than erroring.

### `threshold` — a measured value against a limit
Renders as a labelled bar.

| field | type | required | notes |
| --- | --- | --- | --- |
| `label` | string | ✓ | what's being measured |
| `value` | number | ✓ | the measured value |
| `limit` | number | | the cap/threshold; drives the bar fill |
| `unit` | string | | prefix, e.g. `£`, `$` |
| `status` | `ok` \| `warn` \| `over` | | bar colour; inferred from value vs limit if omitted |

```jsonc
{ "type": "threshold", "value": { "label": "Refund vs order total", "value": 420, "limit": 400, "unit": "£" } }
```

### `entity` — a profile card (customer, order, account)

| field | type | required | notes |
| --- | --- | --- | --- |
| `name` | string | ✓ | shown with an initials avatar |
| `subtitle` | string | | e.g. "Customer · 2y 4m" |
| `fields` | `[{ label, value }]` | | key/value rows; `value` is string or number |
| `badges` | `[{ label, tone? }]` | | `tone`: `ok` \| `warn` \| `risk` |

```jsonc
{ "type": "entity", "value": {
    "name": "a.popov@example.com", "subtitle": "Order SO-118",
    "fields": [{ "label": "Orders", "value": 14 }, { "label": "Prior refunds", "value": 1 }],
    "badges": [{ "label": "low risk", "tone": "ok" }] } }
```

### `timeline` — an event history
The `value` is an **array** of entries.

| field | type | required | notes |
| --- | --- | --- | --- |
| `label` | string | ✓ | the event |
| `at` | string | | timestamp/label, right-aligned |
| `detail` | string | | extra context |

```jsonc
{ "type": "timeline", "value": [
    { "label": "Delivered", "at": "Jun 9" },
    { "label": "Damage reported", "at": "Jun 10", "detail": "photo attached" } ] }
```

### `table` — tabular line items / comparisons

| field | type | required | notes |
| --- | --- | --- | --- |
| `columns` | string[] | ✓ | header row |
| `rows` | `(string\|number)[][]` | ✓ | one array per row; first 12 shown |

```jsonc
{ "type": "table", "value": { "columns": ["Item", "Qty", "£"], "rows": [["Lamp", 1, 420]] } }
```

### `media` — an image (screenshot, photo)
Provide **one** of `url` / `dataUrl`. Only `https:` and `data:image/…` are rendered (never `javascript:`/`file:`);
images load with no referrer and self-hide if they fail. Click to enlarge.

| field | type | required | notes |
| --- | --- | --- | --- |
| `url` | string (https) | one of | remote image |
| `dataUrl` | string (`data:image/…`) | one of | inline image |
| `caption` | string | | shown under the image |

```jsonc
{ "type": "media", "value": { "url": "https://…/damage.jpg", "caption": "Cracked base" } }
```

### `source` — a citation (support thread, dispute, document)

| field | type | required | notes |
| --- | --- | --- | --- |
| `title` | string | | heading |
| `url` | string (https) | | "Open original" link (new tab, `noopener`) |
| `snippet` | string | | excerpt; long ones expand in place |
| `verified` | boolean | | badge — set **only** if independently verifiable (e.g. a signed object) |

```jsonc
{ "type": "source", "value": { "title": "Support ticket #4821", "snippet": "…arrived cracked…", "url": "https://…" } }
```

### `conversation` — a chat / support thread
Renders as a message-bubble transcript: senders matching `agent`/`support`/`staff`/`team`/`system`/`us`/`merchant`/
`seller`/`admin`/`bot` align right + tinted; everyone else (the customer) aligns left. `value` may be `{ messages }`
or a bare array of messages.

| field | type | required | notes |
| --- | --- | --- | --- |
| `title` | string | | thread heading |
| `messages` | ConversationMessage[] | ✓ | the transcript |

**ConversationMessage**

| field | type | required | notes |
| --- | --- | --- | --- |
| `from` | string | | sender label; drives bubble side + tint |
| `text` | string | one of text/image | message body |
| `image` | string (https / `data:image/…`) | one of text/image | an attachment (e.g. a customer's photo), shown inline in the bubble |
| `at` | string | | timestamp under the bubble |

```jsonc
{ "type": "conversation", "value": { "title": "Support thread #4821", "messages": [
    { "from": "customer", "text": "The lamp arrived cracked.", "at": "Jun 10" },
    { "from": "agent",    "text": "So sorry — could you send a photo?", "at": "Jun 10" },
    { "from": "customer", "text": "Here it is:", "image": "https://…/damage.jpg", "at": "Jun 10" } ] } }
```

### Anything else → generic card
An unrecognised `type` renders its `value` as text (if a string) or pretty-printed JSON, under the type name. Use
this freely for one-off evidence — it always shows, it just isn't bespoke-styled.

```jsonc
{ "type": "carrier_scan", "value": { "tracking": "JD0002", "status": "delivered", "scans": 3 } }
```

---

## Layout — side-by-side cards

Each evidence item takes an optional **`width`** alongside `type`/`value`:

| `width` | effect |
| --- | --- |
| `"half"` | the card can pair beside another `half` card |
| `"full"` | the card takes the whole row |
| *(omitted)* | sensible default — **`threshold` and `entity` render `half`**, everything else `full` |

```jsonc
{ "type": "threshold", "value": { … }, "width": "half" }
```

So compact cards (a bar, a profile) sit two-up while rich cards (a thread, an image) get the full width — automatically, with no `width` needed. It's a responsive flex layout: below the half cards' min-width everything stacks, so the narrow ledger drawer is never cramped.

---

## Notes

- **Integrity, not veracity.** The evidence is hashed into the signed attestation (`context_hash`), so an auditor
  can confirm it's exactly what the reviewer saw — but ClearedBy never claims it's *true*. See
  [`docs/proof-verification.md`](https://github.com/ClearedBy/clearedby-js) → Evidence integrity.
- **Security.** Images are restricted to `https:` / `data:image/…` and load with no referrer; links open with
  `rel="noopener noreferrer"`; no evidence is ever rendered as raw HTML. Keep evidence reasonably small — it travels
  in the gate payload.
- **Forward-compatible.** New card types don't need a server deploy — `value` is open-typed end to end. The SDK
  ships TypeScript types (`ThresholdEvidence`, `EntityEvidence`, … `ConversationEvidence`) — annotate a `value` or
  use `satisfies Evidence` to get them checked.
