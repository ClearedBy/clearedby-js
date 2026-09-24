// A FAKE session so the example runs without a login system. Replace
// currentUser() with a lookup in your real session (cookie, JWT, NextAuth…):
// it must return the ClearedBy org of the merchant the person is working in and
// the external_subject you provisioned them with — or null if nobody is signed in.
//
// Here the org always comes from the server's environment. The person can be
// switched with a `demo_subject` cookie (see the picker on the page) so you can
// compare what an owner and a plain reviewer see. Never let a real browser pick
// its own identity like this.

import type { ProxyUser } from '@clearedby/sdk/partner-proxy'

export const DEMO_SUBJECTS = (process.env.CLEAREDBY_DEMO_SUBJECTS ?? 'owner_1')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

function cookie(req: Request, name: string): string | null {
  const header = req.headers.get('cookie') ?? ''
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === name) return decodeURIComponent(v.join('='))
  }
  return null
}

export function currentUser(req: Request): ProxyUser | null {
  const orgId = process.env.CLEAREDBY_DEMO_ORG_ID
  if (!orgId) return null
  const picked = cookie(req, 'demo_subject')
  const subject = picked !== null && DEMO_SUBJECTS.includes(picked) ? picked : DEMO_SUBJECTS[0]
  return subject ? { org_id: orgId, external_subject: subject } : null
}
