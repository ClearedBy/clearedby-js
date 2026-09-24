# partner-approvals-next

A minimal Next.js (App Router) app that embeds an approval experience for your
merchants with [`@clearedby/react`](../../packages/react) and
[`@clearedby/sdk/partner-proxy`](../../packages/sdk). Your merchants see a queue,
review each change in plain English, approve / decline / send back / ask
someone else, adjust their approval rules, and cancel an approved change before
it runs, all inside your app.

```
browser ──▶ /api/clearedby/* (this app, the proxy) ──▶ ClearedBy
             resolveUser() = your session         partner key + short-lived tokens, server-side only
```

## What's in it

| File | What it does |
| --- | --- |
| `app/api/clearedby/[...path]/route.ts` | The whole server side: `createPartnerProxy({ partnerKey, resolveUser })`. |
| `lib/session.ts` | A **fake** `resolveUser`: the org comes from the server's env, the person from a demo cookie. Replace it with your real session lookup. |
| `app/approvals.tsx` | `<ClearedByProvider>` + `<ApprovalQueue>` + `<ReviewPanel>` + `<RulesSummary>`, and a "Look" switch showing the three styling levels: the default look (inherits the page), a brand theme passed as tokens, and your own classes + components with the default CSS turned off. |
| `app/app.css` | The host app's own styles, including the `--cb-*` variables and the `.ds-*` classes the "own classes" look uses. |

## Run it

1. **Get a merchant org with a couple of reviewers** (once), with your partner key:

   ```bash
   curl -X POST https://app.clearedby.com/v1/partner/orgs -H "authorization: Bearer $CLEAREDBY_PARTNER_KEY" \
     -H 'content-type: application/json' \
     -d '{"external_id":"demo-shop","name":"Acme Outdoor","currency":"GBP","shop_domains":["acme-outdoor.myshopify.com"]}'
   # → org_id, and a one-time cb_live_ api_key for your agent

   curl -X PUT https://app.clearedby.com/v1/partner/orgs/$ORG_ID/reviewers/owner_1 -H "authorization: Bearer $CLEAREDBY_PARTNER_KEY" \
     -H 'content-type: application/json' -d '{"display_name":"Olivia","role":"owner","authority":{"*":100000000}}'
   curl -X PUT https://app.clearedby.com/v1/partner/orgs/$ORG_ID/reviewers/reviewer_2 -H "authorization: Bearer $CLEAREDBY_PARTNER_KEY" \
     -H 'content-type: application/json' -d '{"display_name":"Sam","role":"reviewer","authority":{"shopify.refund.create":5000}}'
   ```

2. **Hold something for review**, as your agent would (the default rules hold refunds over £25):

   ```bash
   curl -X POST https://app.clearedby.com/v1/gate -H "authorization: Bearer $CB_LIVE_KEY" -H 'content-type: application/json' -d '{
     "action": "shopify.refund.create",
     "params": { "store": "acme-outdoor.myshopify.com", "order_id": "gid://shopify/Order/6001", "amount": 120, "currency": "GBP", "reason": "Arrived damaged" },
     "context": { "subject_id": "gid://shopify/Customer/7208314339542" },
     "proof": { "reason": "Photos of the damage in the support chat", "confidence": 0.86 }
   }'
   ```

3. **Configure and start the app:**

   ```bash
   cp .env.example .env.local   # partner key, org id, the reviewer ids above
   pnpm install
   pnpm dev                     # http://localhost:3219
   ```

Switch **Signed in as** between `owner_1` and `reviewer_2` to see permission-gated
buttons (Sam's £50 refund limit hides "Approve" on the £120 refund; he can
still decline, send it back or ask someone else), and the owner-only "Yes,
change it" when rules get less strict. Switch **Look** to compare the styling levels.

## Going to production

- Replace `lib/session.ts` with your real session: return `{ org_id, external_subject }`
  for the signed-in person (the ClearedBy org of the merchant they're working in,
  and the id you provisioned them with), or `null`.
- Keep `CLEAREDBY_PARTNER_KEY` server-side (never `NEXT_PUBLIC_…`).
- Optionally store your theme once: `npx @clearedby/react theme --from app/globals.css --push`.
- For instant updates, forward ClearedBy's lifecycle webhooks to the browser and
  call `useRevalidate()`; otherwise views refresh every 15 seconds while visible.
