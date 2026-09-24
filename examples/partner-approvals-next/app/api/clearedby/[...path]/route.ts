// The whole server side of the embedded approval UI: one catch-all route.
//
// The browser calls /api/clearedby/...; this proxy works out who is signed in
// (resolveUser), mints a short-lived token for exactly that person, and calls
// ClearedBy itself. The partner key and the tokens never leave this server.

import { createPartnerProxy } from '@clearedby/sdk/partner-proxy'
import { currentUser } from '../../../../lib/session'

const proxy = createPartnerProxy({
  partnerKey: process.env.CLEAREDBY_PARTNER_KEY!,
  baseUrl: process.env.CLEAREDBY_BASE_URL, // optional; defaults to https://app.clearedby.com
  basePath: '/api/clearedby',
  // YOUR session → the merchant org and the person. Never read from the request body.
  resolveUser: (req) => currentUser(req),
})

export const dynamic = 'force-dynamic'
export const GET = proxy.handle
export const POST = proxy.handle
export const PUT = proxy.handle
