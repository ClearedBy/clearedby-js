// @clearedby/sdk/partner-proxy (CLE-219) — the server half of an embedded
// approval UI (@clearedby/react is the browser half).
//
// Your merchants' reviewers use approvals inside YOUR app. Their browser talks
// to YOUR backend (this proxy, mounted at e.g. /api/clearedby); the proxy works
// out who they are with your own session (`resolveUser`), mints a short-lived
// reviewer token for exactly that person in exactly that org, and calls the
// ClearedBy API itself. So:
//
//   - the partner key (`cb_partner_…`) never leaves your server;
//   - no ClearedBy token ever reaches the browser (the proxy keeps them);
//   - the org and the person ALWAYS come from `resolveUser`, never from the
//     request (an `org_id` or `reviewer` the browser sends is ignored);
//   - only a small, fixed set of routes exists — nothing else is forwarded.
//
// Web Fetch API in, Web Fetch API out, so it drops straight into a Next.js App
// Router catch-all route (`app/api/clearedby/[...path]/route.ts`), Hono, Remix,
// Bun, Deno, Cloudflare Workers… `expressHandler()` adapts it to Express.
// Zero dependencies; Node 18+ (global fetch / Request / Response).
//
// Routes (relative to `basePath`):
//
//   GET  /items                       the reviewer's queue (read token)
//   GET  /items/:id                   one item in full (read token)
//   GET  /items/:id/events            its history, incl. revisions (read token)
//   GET  /items/:id/permissions       what this reviewer may do (read token)
//   POST /items/:id/decide            approve / decline / send back / ask someone else
//   POST /items/:id/revoke            cancel an approved change before it runs
//   GET  /rules                       the merchant's approval rules (+ viewer role)
//   PUT  /rules                       change them (stricter: live now; looser: proposal)
//   POST /rules/proposals/:id/accept  an owner/admin accepts a looser proposal
//   GET  /theme                       the design tokens for this merchant (data only)

export interface ProxyUser {
  /** The ClearedBy org of the merchant this person is acting for. */
  org_id: string
  /** Your id for the person (the `external_subject` you provisioned them with). */
  external_subject: string
}

export interface PartnerProxyOptions {
  /** `cb_partner_…`. Server-side only — the proxy never echoes it. */
  partnerKey: string
  /** Defaults to https://app.clearedby.com */
  baseUrl?: string
  /**
   * Who is asking, from YOUR session (cookie, JWT…). Return null when nobody is
   * signed in, or they may not approve anything: the proxy answers 401.
   * This is the ONLY source of the org and the person.
   */
  resolveUser: (req: Request) => Promise<ProxyUser | null> | ProxyUser | null
  /** Where the proxy is mounted. Default '/api/clearedby'. */
  basePath?: string
  /**
   * May this person change the merchant's approval rules? Default: yes — a
   * looser change still needs an owner or admin to accept it, which ClearedBy
   * enforces itself. Return false to hide rule editing from some people.
   */
  canEditRules?: (user: ProxyUser, req: Request) => Promise<boolean> | boolean
  /**
   * Extra origins allowed to send writes (POST/PUT). Same-origin writes are
   * always allowed; writes from any other Origin get 403 (CSRF defense).
   */
  allowedOrigins?: string[]
  /** Custom fetch (tests, instrumentation). */
  fetch?: typeof fetch
  /** Read-token lifetime in seconds (60–900). Default 600. Tokens are cached per person. */
  readTokenTtlSeconds?: number
}

export interface PartnerProxy {
  /** Handle one request. Unknown routes are 404; nothing is forwarded blindly. */
  handle(req: Request): Promise<Response>
  /** Drop cached read tokens (all, or one person's). */
  clearTokenCache(user?: ProxyUser): void
}

type Params = Record<string, string>
type Handler = (ctx: RouteCtx) => Promise<Response>

interface RouteCtx {
  req: Request
  url: URL
  user: ProxyUser
  params: Params
}

interface Route {
  method: 'GET' | 'POST' | 'PUT'
  pattern: RegExp
  keys: string[]
  handler: Handler
}

const ID_RE = '([0-9A-Za-z_-]{1,64})'
const MAX_BODY_BYTES = 16 * 1024
const DECISIONS = new Set(['clear', 'reject', 'send_back', 'escalate'])
const LIST_STATUSES = new Set(['pending', 'escalated', 'cleared', 'rejected', 'expired', 'sent_back', 'revoked', 'withdrawn'])
const LIST_INCLUDES = new Set(['params', 'proof'])
const SAFE_ID = /^[A-Za-z0-9._:@|+=-]{1,200}$/
const THEME_CACHE_MS = 5 * 60_000

/** A JSON response with no-store caching (these are per-person views). */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

function fail(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status)
}

class ProxyError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
  }
}

/** Remove anything credential-like before a ClearedBy response reaches the browser. */
function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub)
  if (value === null || typeof value !== 'object') {
    // Belt and braces: no ClearedBy secret shape ever passes through.
    if (typeof value === 'string' && /\bcb_(partner|live|dt)_[0-9A-Za-z]+/.test(value)) return '[redacted]'
    return value
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    // Signed receipts authorise the executor, not the browser; tokens never leave.
    if (k === 'receipt' || k === 'token' || k === 'api_key') continue
    out[k] = scrub(v)
  }
  return out
}

export function createPartnerProxy(opts: PartnerProxyOptions): PartnerProxy {
  if (!opts?.partnerKey) throw new Error('createPartnerProxy: partnerKey is required')
  if (typeof opts.resolveUser !== 'function') throw new Error('createPartnerProxy: resolveUser is required')
  const baseUrl = (opts.baseUrl ?? 'https://app.clearedby.com').replace(/\/$/, '')
  const basePath = `/${(opts.basePath ?? '/api/clearedby').replace(/^\/+|\/+$/g, '')}`
  const fetchImpl = opts.fetch ?? (globalThis.fetch as typeof fetch | undefined)
  if (!fetchImpl) throw new Error('createPartnerProxy: no fetch available — pass options.fetch')
  const readTtl = Math.min(900, Math.max(60, Math.floor(opts.readTokenTtlSeconds ?? 600)))
  const partnerKey = opts.partnerKey

  // ---- upstream -------------------------------------------------------------------

  async function upstream(method: string, path: string, bearer: string, body?: unknown): Promise<{ status: number; json: any }> {
    const res = await fetchImpl!(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${bearer}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const parsed = await res.json().catch(() => ({}))
    return { status: res.status, json: parsed }
  }

  /** Pass ClearedBy's answer on: its status + a scrubbed body; errors keep only code + message. */
  function relay(r: { status: number; json: any }, okStatuses: number[] = [200]): Response {
    if (okStatuses.includes(r.status)) return json(scrub(r.json), r.status)
    const code = typeof r.json?.error?.code === 'string' ? r.json.error.code : 'upstream_error'
    const message = typeof r.json?.error?.message === 'string' ? r.json.error.message : 'the request could not be completed'
    // Our own credentials being refused is our problem, not the browser's.
    if (r.status === 401 && (code === 'unauthorized' || code === 'invalid_token')) {
      return fail(502, 'upstream_auth', 'the approvals service refused this server’s credentials')
    }
    return json({ error: { code, message: typeof message === 'string' ? String(scrub(message)) : message } }, r.status)
  }

  // ---- tokens (never sent to the browser) -----------------------------------------

  const readCache = new Map<string, { token: string; expiresAt: number }>()
  const cacheKey = (u: ProxyUser): string => `${u.org_id}\u0000${u.external_subject}`

  async function mint(user: ProxyUser, extra: Record<string, unknown>): Promise<string> {
    const r = await upstream('POST', '/v1/auth/decision-token', partnerKey, {
      org_id: user.org_id,
      external_subject: user.external_subject,
      ...extra,
    })
    if (r.status !== 201 || typeof r.json?.token !== 'string') {
      const code = typeof r.json?.error?.code === 'string' ? r.json.error.code : 'token_failed'
      // 404 = unknown org/person for this partner; 403 = removed person.
      if (r.status === 404) throw new ProxyError(403, 'not_a_reviewer', 'this person can’t review approvals for this business')
      if (r.status === 403) throw new ProxyError(403, code, 'this person can no longer review approvals')
      throw new ProxyError(502, 'upstream_auth', 'could not authorise this request with the approvals service')
    }
    return r.json.token as string
  }

  async function readToken(user: ProxyUser): Promise<string> {
    const hit = readCache.get(cacheKey(user))
    // Refresh a minute early so a token never expires mid-request.
    if (hit !== undefined && hit.expiresAt - 60_000 > Date.now()) return hit.token
    const token = await mint(user, { scope: 'read', ttl_seconds: readTtl })
    readCache.set(cacheKey(user), { token, expiresAt: Date.now() + readTtl * 1000 })
    return token
  }

  /** A read with the person's cached read token; one retry with a fresh token on 401. */
  async function read(user: ProxyUser, path: string): Promise<{ status: number; json: any }> {
    let r = await upstream('GET', path, await readToken(user))
    if (r.status === 401) {
      readCache.delete(cacheKey(user))
      r = await upstream('GET', path, await readToken(user))
    }
    return r
  }

  /** A fresh single-use decide token, pinned to the item when there is one. */
  const decideToken = (user: ProxyUser, workItemId?: string): Promise<string> =>
    mint(user, { ttl_seconds: 60, ...(workItemId === undefined ? {} : { work_item_id: workItemId }) })

  // ---- request helpers ------------------------------------------------------------

  async function readBody(req: Request): Promise<Record<string, unknown>> {
    const type = req.headers.get('content-type') ?? ''
    if (!type.toLowerCase().startsWith('application/json')) {
      throw new ProxyError(415, 'unsupported_media_type', 'send the body as application/json')
    }
    const text = await req.text()
    if (text.length > MAX_BODY_BYTES) throw new ProxyError(413, 'body_too_large', 'request body is too large')
    if (text.trim() === '') return {}
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      throw new ProxyError(400, 'invalid_body', 'request body must be JSON')
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new ProxyError(400, 'invalid_body', 'request body must be a JSON object')
    return raw as Record<string, unknown>
  }

  function onlyKeys(body: Record<string, unknown>, allowed: string[]): void {
    const extra = Object.keys(body).find((k) => !allowed.includes(k))
    if (extra !== undefined) throw new ProxyError(400, 'invalid_body', `unexpected field '${extra}'`)
  }

  function sameOriginWrite(req: Request, url: URL): boolean {
    const origin = req.headers.get('origin')
    if (origin === null) {
      // No Origin: a same-origin navigation/fetch in older browsers or a server
      // call. Sec-Fetch-Site, when present, must not be cross-site.
      const site = req.headers.get('sec-fetch-site')
      return site === null || site === 'same-origin' || site === 'none'
    }
    const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? url.host
    try {
      const o = new URL(origin)
      if (o.host === host) return true
    } catch {
      return false
    }
    return (opts.allowedOrigins ?? []).includes(origin)
  }

  const enc = encodeURIComponent

  // ---- routes ---------------------------------------------------------------------

  const routes: Route[] = []
  const add = (method: Route['method'], path: string, handler: Handler): void => {
    const keys: string[] = []
    const src = path.replace(/:([a-z_]+)/g, (_m, k: string) => {
      keys.push(k)
      return ID_RE
    })
    routes.push({ method, pattern: new RegExp(`^${src}$`), keys, handler })
  }

  add('GET', '/items', async ({ url, user }) => {
    const q = new URLSearchParams()
    const status = url.searchParams.get('status')
    if (status !== null && status !== '') {
      const parts = status.split(',').map((s) => s.trim()).filter(Boolean)
      if (parts.some((s) => !LIST_STATUSES.has(s))) throw new ProxyError(400, 'invalid_query', 'unknown status')
      q.set('status', parts.join(','))
    }
    const include = (url.searchParams.get('include') ?? 'params').split(',').map((s) => s.trim()).filter((s) => LIST_INCLUDES.has(s))
    if (include.length > 0) q.set('include', include.join(','))
    const actionPrefix = url.searchParams.get('action_prefix')
    if (actionPrefix) q.set('action_prefix', actionPrefix.slice(0, 128))
    const batchId = url.searchParams.get('batch_id')
    if (batchId) q.set('batch_id', batchId.slice(0, 256))
    const cursor = url.searchParams.get('cursor')
    if (cursor) q.set('cursor', cursor.slice(0, 512))
    const limit = url.searchParams.get('limit')
    if (limit) {
      const n = Number(limit)
      if (!Number.isInteger(n) || n < 1 || n > 100) throw new ProxyError(400, 'invalid_query', 'limit must be 1–100')
      q.set('limit', String(n))
    }
    // No `reviewer`, no `org_id`: the read token is this person in this org.
    return relay(await read(user, `/v1/gate?${q.toString()}`))
  })

  add('GET', '/items/:id', async ({ user, params }) => relay(await read(user, `/v1/gate/${enc(params.id!)}/detail`)))

  add('GET', '/items/:id/events', async ({ user, params }) =>
    relay(await read(user, `/v1/gate/${enc(params.id!)}/events?include=lineage`)))

  add('GET', '/items/:id/permissions', async ({ user, params }) =>
    relay(await read(user, `/v1/gate/${enc(params.id!)}/permissions`)))

  add('POST', '/items/:id/decide', async ({ req, user, params }) => {
    const body = await readBody(req)
    onlyKeys(body, ['decision', 'reason', 'escalate_to'])
    if (typeof body.decision !== 'string' || !DECISIONS.has(body.decision)) {
      throw new ProxyError(400, 'invalid_body', "decision must be 'clear', 'reject', 'send_back' or 'escalate'")
    }
    if (body.reason !== undefined && (typeof body.reason !== 'string' || body.reason.length > 4000)) {
      throw new ProxyError(400, 'invalid_body', 'reason must be text (up to 4000 characters)')
    }
    if ((body.decision === 'reject' || body.decision === 'send_back') && (typeof body.reason !== 'string' || body.reason.trim().length < 4)) {
      throw new ProxyError(400, 'reason_required', 'please add a short note (at least 4 characters)')
    }
    if (body.escalate_to !== undefined && (body.decision !== 'escalate' || typeof body.escalate_to !== 'string' || !SAFE_ID.test(body.escalate_to))) {
      throw new ProxyError(400, 'invalid_body', 'escalate_to is only valid with escalate, as a reviewer id')
    }
    const token = await decideToken(user, params.id)
    const r = await upstream('POST', `/v1/gate/${enc(params.id!)}/decide`, token, {
      decision: body.decision,
      ...(typeof body.reason === 'string' && body.reason.trim() !== '' ? { reason: body.reason.trim() } : {}),
      ...(typeof body.escalate_to === 'string' ? { escalate_to: body.escalate_to } : {}),
    })
    return relay(r)
  })

  add('POST', '/items/:id/revoke', async ({ req, user, params }) => {
    const body = await readBody(req)
    onlyKeys(body, ['reason'])
    if (typeof body.reason !== 'string' || body.reason.trim().length < 4 || body.reason.length > 2000) {
      throw new ProxyError(400, 'reason_required', 'please say why (at least 4 characters)')
    }
    // Revoked AS this person: ClearedBy checks they may (owner/admin, or authority).
    const token = await decideToken(user, params.id)
    return relay(await upstream('POST', `/v1/gate/${enc(params.id!)}/revoke`, token, { reason: body.reason.trim() }))
  })

  async function viewerRole(user: ProxyUser): Promise<string | null> {
    const r = await upstream('GET', `/v1/partner/orgs/${enc(user.org_id)}/reviewers`, partnerKey)
    if (r.status !== 200 || !Array.isArray(r.json?.reviewers)) return null
    const me = (r.json.reviewers as Array<Record<string, unknown>>).find(
      (p) => p.external_subject === user.external_subject && p.active !== false,
    )
    return typeof me?.role === 'string' ? me.role : null
  }

  add('GET', '/rules', async ({ req, user }) => {
    const [rules, role] = await Promise.all([
      upstream('GET', `/v1/partner/orgs/${enc(user.org_id)}/rules`, partnerKey),
      viewerRole(user),
    ])
    if (rules.status !== 200) return relay(rules)
    const canEdit = opts.canEditRules === undefined ? true : await opts.canEditRules(user, req)
    return json({
      ...(scrub(rules.json) as Record<string, unknown>),
      viewer: {
        role,
        can_edit: canEdit,
        can_accept: role === 'owner' || role === 'admin',
      },
    })
  })

  add('PUT', '/rules', async ({ req, user }) => {
    const body = await readBody(req)
    onlyKeys(body, ['settings'])
    if (body.settings === null || typeof body.settings !== 'object' || Array.isArray(body.settings)) {
      throw new ProxyError(400, 'invalid_body', 'settings must be an object')
    }
    if (opts.canEditRules !== undefined && !(await opts.canEditRules(user, req))) {
      throw new ProxyError(403, 'forbidden', 'you can’t change the approval rules')
    }
    const r = await upstream('PUT', `/v1/partner/orgs/${enc(user.org_id)}/rules`, partnerKey, { settings: body.settings })
    return relay(r, [200, 202])
  })

  // The merchant's look (CLE-219): partner theme + org override, as data only.
  const themeCache = new Map<string, { at: number; body: unknown }>()
  add('GET', '/theme', async ({ user }) => {
    const hit = themeCache.get(user.org_id)
    if (hit !== undefined && Date.now() - hit.at < THEME_CACHE_MS) return json(hit.body)
    const r = await upstream('GET', `/v1/partner/orgs/${enc(user.org_id)}/theme`, partnerKey)
    if (r.status !== 200) return relay(r)
    const body = { theme: (scrub(r.json) as { theme?: unknown }).theme ?? null }
    themeCache.set(user.org_id, { at: Date.now(), body })
    return json(body)
  })

  add('POST', '/rules/proposals/:proposal_id/accept', async ({ user, params }) => {
    const token = await decideToken(user)
    return relay(await upstream(
      'POST',
      `/v1/partner/orgs/${enc(user.org_id)}/rules/${enc(params.proposal_id!)}/accept`,
      token,
    ))
  })

  // ---- dispatch -------------------------------------------------------------------

  async function handle(req: Request): Promise<Response> {
    let url: URL
    try {
      url = new URL(req.url)
    } catch {
      return fail(400, 'bad_request', 'bad request URL')
    }
    const path = url.pathname.replace(/\/+$/, '')
    if (path !== basePath && !path.startsWith(`${basePath}/`)) return fail(404, 'not_found', 'no such route')
    const sub = path.slice(basePath.length) || '/'

    let matched: Route | undefined
    let params: Params = {}
    let pathMatched = false
    for (const r of routes) {
      const m = r.pattern.exec(sub)
      if (m === null) continue
      pathMatched = true
      if (r.method !== req.method) continue
      matched = r
      params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1] as string]))
      break
    }
    if (matched === undefined) {
      return pathMatched ? fail(405, 'method_not_allowed', 'method not allowed') : fail(404, 'not_found', 'no such route')
    }
    if (req.method !== 'GET' && !sameOriginWrite(req, url)) {
      return fail(403, 'cross_site', 'cross-site request refused')
    }

    let user: ProxyUser | null
    try {
      user = await opts.resolveUser(req)
    } catch {
      user = null
    }
    if (user === null || user === undefined || typeof user.org_id !== 'string' || user.org_id === ''
      || typeof user.external_subject !== 'string' || user.external_subject === '') {
      return fail(401, 'unauthenticated', 'please sign in')
    }
    // Copy: nothing a handler does can change who this is.
    const who: ProxyUser = Object.freeze({ org_id: user.org_id, external_subject: user.external_subject })

    try {
      return await matched.handler({ req, url, user: who, params })
    } catch (err) {
      if (err instanceof ProxyError) return fail(err.status, err.code, err.message)
      return fail(502, 'upstream_unavailable', 'the approvals service could not be reached')
    }
  }

  return {
    handle,
    clearTokenCache(user?: ProxyUser) {
      if (user === undefined) readCache.clear()
      else readCache.delete(cacheKey(user))
    },
  }
}

// ---- Express adapter ------------------------------------------------------------------

/** The subset of Express's req/res this adapter touches (no express types needed). */
export interface ExpressLikeRequest {
  method: string
  originalUrl?: string
  url: string
  headers: Record<string, string | string[] | undefined>
  protocol?: string
  body?: unknown
  on?: (event: string, cb: (...args: any[]) => void) => unknown
}
export interface ExpressLikeResponse {
  status(code: number): ExpressLikeResponse
  setHeader(name: string, value: string): unknown
  send(body: string): unknown
}

async function readNodeBody(req: ExpressLikeRequest): Promise<string> {
  if (req.body !== undefined) {
    if (typeof req.body === 'string') return req.body
    // express.raw() gives a Buffer; express.json() an already-parsed object.
    if (req.body instanceof Uint8Array) return new TextDecoder().decode(req.body)
    return JSON.stringify(req.body)
  }
  if (typeof req.on !== 'function') return ''
  return await new Promise<string>((resolve, reject) => {
    const chunks: Uint8Array[] = []
    let size = 0
    req.on!('data', (c: Uint8Array | string) => {
      const buf = typeof c === 'string' ? new TextEncoder().encode(c) : c
      size += buf.length
      if (size > MAX_BODY_BYTES * 2) reject(new Error('body too large'))
      else chunks.push(buf)
    })
    req.on!('end', () => {
      const all = new Uint8Array(size)
      let o = 0
      for (const c of chunks) {
        all.set(c, o)
        o += c.length
      }
      resolve(new TextDecoder().decode(all))
    })
    req.on!('error', reject)
  })
}

/**
 * Adapt a proxy to Express (or any Node `(req, res)` framework with
 * status/setHeader/send). Mount it on the SAME path as `basePath`:
 *
 *   app.use('/api/clearedby', expressHandler(proxy))
 */
export function expressHandler(proxy: PartnerProxy) {
  return async (req: ExpressLikeRequest, res: ExpressLikeResponse, next?: (err?: unknown) => void): Promise<void> => {
    try {
      const host = String(req.headers.host ?? 'localhost')
      const url = `${req.protocol ?? 'http'}://${host}${req.originalUrl ?? req.url}`
      const headers = new Headers()
      for (const [k, v] of Object.entries(req.headers)) {
        if (v === undefined) continue
        headers.set(k, Array.isArray(v) ? v.join(', ') : String(v))
      }
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
      const body = hasBody ? await readNodeBody(req) : undefined
      const response = await proxy.handle(new Request(url, { method: req.method, headers, ...(hasBody ? { body } : {}) }))
      res.status(response.status)
      response.headers.forEach((value, name) => {
        res.setHeader(name, value)
      })
      res.send(await response.text())
    } catch (err) {
      if (next) next(err)
      else {
        res.status(500)
        res.send('{"error":{"code":"internal","message":"internal error"}}')
      }
    }
  }
}
