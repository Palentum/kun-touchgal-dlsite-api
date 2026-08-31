import type { IncomingMessage, ServerResponse } from 'node:http'
import { expect, test, vi } from 'vitest'

// Both constants are read per call inside createRequestInit / fetchDlsiteData,
// so a getter pair is enough to rebudget per test — production keeps zero
// config surface (no env knob).
const timeouts = vi.hoisted(() => ({ fetch: 10_000, total: 30_000 }))

vi.mock('../src/dlsite/constants', async () => {
  const actual = await vi.importActual<
    typeof import('../src/dlsite/constants')
  >('../src/dlsite/constants')
  return {
    ...actual,
    get FETCH_TIMEOUT_MS() {
      return timeouts.fetch
    },
    get TOTAL_TIMEOUT_MS() {
      return timeouts.total
    }
  }
})

const { fetchDlsiteData } = await import('../src/dlsite')
const { handleRequest } = await import('../src/server')

let fetchCount = 0

// An upstream that completes the connection and never sends headers — before
// the fix this hung all the way to undici's 300s default
const hangingFetch = (_input: RequestInfo | URL, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    fetchCount += 1
    const signal = init?.signal
    if (!signal) return
    signal.addEventListener('abort', () =>
      reject(signal.reason ?? new DOMException('aborted', 'AbortError'))
    )
  })

const SPA_SHELL_HTML =
  '<!doctype html><html><body><div id="app"></div></body></html>'

// 页面立即 200（SPA 壳，逼进 product.json 路径）；product.json 也立即 200，
// 但 body 流挂死到信号中止。json() 阶段的超时是 DOMException，必须原样穿过
// fetchProductApi 的内层 catch、命中既有超时映射 —— 误判成 non-JSON 会让
// 每个 locale 继续探完 5 个版块，每个版块再烧一个 FETCH_TIMEOUT_MS。
const hangingJsonBodyFetch = (input: RequestInfo | URL, init?: RequestInit) => {
  fetchCount += 1
  const url =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url
  if (!url.includes('/api/=/product.json')) {
    return Promise.resolve(new Response(SPA_SHELL_HTML, { status: 200 }))
  }
  const signal = init?.signal
  return Promise.resolve({
    ok: true,
    status: 200,
    statusText: 'OK',
    url,
    json: () =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason))
      })
  } as unknown as Response)
}

// Every hop answers, just slowly — exercises the budget against the serial
// candidate loop rather than a single stuck request
const slow404Fetch = (_input: RequestInfo | URL, init?: RequestInit) =>
  new Promise<Response>((resolve, reject) => {
    fetchCount += 1
    const timer = setTimeout(
      () => resolve(new Response('', { status: 404 })),
      20
    )
    init?.signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(init.signal?.reason)
    })
  })

const runWith = async (
  impl: typeof hangingFetch,
  budget: { fetch: number; total: number },
  fn: () => Promise<void>
) => {
  const originalFetch = globalThis.fetch
  const originalTimeouts = { ...timeouts }
  fetchCount = 0
  Object.assign(timeouts, budget)
  globalThis.fetch = impl as typeof globalThis.fetch
  try {
    await fn()
  } finally {
    globalThis.fetch = originalFetch
    Object.assign(timeouts, originalTimeouts)
  }
}

const createRes = () => {
  const listeners: Record<string, Array<() => void>> = {}
  return {
    statusCode: 0,
    body: '',
    writableFinished: false,
    setHeader: () => {},
    on(event: string, cb: () => void) {
      ;(listeners[event] ??= []).push(cb)
      return this
    },
    emit(event: string) {
      listeners[event]?.forEach((cb) => cb())
    },
    end(chunk?: string) {
      this.body = chunk ?? ''
      this.writableFinished = true
    }
  }
}

const REQ = {
  url: '/api/dlsite?code=RJ01527759',
  method: 'GET',
  headers: {}
} as unknown as IncomingMessage

test('a hung upstream request is aborted by the per-hop timeout', async () => {
  await runWith(hangingFetch, { fetch: 20, total: 10_000 }, async () => {
    await expect(fetchDlsiteData('RJ01527759')).rejects.toThrow(
      'DLsite request failed: upstream timeout'
    )
    // 1, not 5: a 403 lets the loop try the next candidate, a timeout must not.
    // Probing on would burn another FETCH_TIMEOUT_MS per section and hold a gate
    // slot for the whole TOTAL_TIMEOUT_MS instead of one hop
    expect(fetchCount).toBe(1)
  })
})

test('a stalled product.json body maps to upstream timeout, not non-JSON', async () => {
  await runWith(hangingJsonBodyFetch, { fetch: 20, total: 10_000 }, async () => {
    await expect(fetchDlsiteData('RJ01527759')).rejects.toThrow(
      'DLsite request failed: upstream timeout'
    )
    // 1 个壳页 + 3 locale x 1 版块：json() 阶段的超时同样立即终止该 locale 的
    // 候选循环。丢掉 DOMException 放行时这里是 16（3 locale 各探完 5 版块）。
    expect(fetchCount).toBe(4)
  })
})

test('the total budget caps serial candidate probing', async () => {
  // Per-hop cap is far out of reach here, so only the call-wide budget can fire
  await runWith(slow404Fetch, { fetch: 10_000, total: 60 }, async () => {
    await expect(fetchDlsiteData('RJ01527759')).rejects.toThrow(
      'DLsite request failed: upstream timeout'
    )
    // 5 candidate sections x 3 hops = 15 serial requests for an RJ code
    expect(fetchCount).toBeLessThan(15)
  })
})

test('an upstream timeout surfaces as 502, never 404', async () => {
  await runWith(hangingFetch, { fetch: 20, total: 10_000 }, async () => {
    const res = createRes()
    await handleRequest(REQ, res as unknown as ServerResponse)

    // TouchGal persists 404s, so one upstream stall must not record a real work
    // as permanently nonexistent
    expect(res.statusCode).toBe(502)
    expect(JSON.parse(res.body)).toEqual({
      error: 'DLsite request failed: upstream timeout'
    })
  })
})

test('a client disconnect aborts the in-flight scrape', async () => {
  await runWith(hangingFetch, { fetch: 10_000, total: 30_000 }, async () => {
    const res = createRes()
    const pending = handleRequest(REQ, res as unknown as ServerResponse)
    expect(fetchCount).toBe(1)

    res.emit('close')
    // Without the abort this would hang to the 10s per-hop cap and then write
    // to a socket nobody is reading
    await expect(pending).resolves.toBeUndefined()
    expect(res.statusCode).toBe(0)
    expect(res.body).toBe('')
  })
})
