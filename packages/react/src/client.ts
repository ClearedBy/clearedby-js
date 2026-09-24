// The browser's only network surface: your own proxy at `basePath`. No
// ClearedBy URL, key or token is ever used here.

export class ApprovalsError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message)
    this.name = 'ApprovalsError'
  }
}

export interface ApprovalsClient {
  get<T>(path: string): Promise<T>
  send<T>(method: 'POST' | 'PUT', path: string, body?: unknown): Promise<T>
}

export function createClient(basePath: string, fetchImpl?: typeof fetch): ApprovalsClient {
  const base = basePath.replace(/\/+$/, '')
  const doFetch = (input: string, init: RequestInit): Promise<Response> => {
    const f = fetchImpl ?? (globalThis.fetch as typeof fetch | undefined)
    if (!f) throw new ApprovalsError('fetch is not available', 0, 'no_fetch')
    return f(input, init)
  }

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        credentials: 'same-origin',
        headers: body === undefined && method === 'GET'
          ? { accept: 'application/json' }
          : { accept: 'application/json', 'content-type': 'application/json' },
        ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
      })
    } catch {
      throw new ApprovalsError('network error', 0, 'network')
    }
    const json = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } }
    if (!res.ok) {
      throw new ApprovalsError(json.error?.message ?? `request failed (${res.status})`, res.status, json.error?.code ?? 'error')
    }
    return json as T
  }

  return {
    get: <T>(path: string) => call<T>('GET', path),
    send: <T>(method: 'POST' | 'PUT', path: string, body?: unknown) => call<T>(method, path, body),
  }
}
