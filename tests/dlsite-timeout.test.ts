import type { IncomingMessage, ServerResponse } from 'node:http'
import { expect, test, vi } from 'vitest'

// 常量在 createRequestInit / fetchDlsiteData 内部按调用读取，用 getter 就能逐个用例
// 改预算，不必给生产代码加 env 开关
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

// 建立了连接却永不发响应头的上游：修复前它会一直挂到 undici 的 300s 兜底
const hangingFetch = (_input: RequestInfo | URL, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    fetchCount += 1
    const signal = init?.signal
    if (!signal) return
    signal.addEventListener('abort', () =>
      reject(signal.reason ?? new DOMException('aborted', 'AbortError'))
    )
  })

// 每跳都能返回，但慢。用来验证总预算能截断串行候选探测的累加
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
  const original = globalThis.fetch
  fetchCount = 0
  timeouts.fetch = budget.fetch
  timeouts.total = budget.total
  globalThis.fetch = impl as typeof globalThis.fetch
  try {
    await fn()
  } finally {
    globalThis.fetch = original
    timeouts.fetch = 10_000
    timeouts.total = 30_000
  }
}

test('a hung upstream request is aborted by the per-hop timeout', async () => {
  await runWith(hangingFetch, { fetch: 20, total: 10_000 }, async () => {
    await expect(fetchDlsiteData('RJ01527759')).rejects.toThrow(
      'DLsite request failed: upstream timeout'
    )
    expect(fetchCount).toBe(1)
  })
})

test('the total budget caps serial candidate probing', async () => {
  // 每跳预算够大，只有整次调用的预算会触发
  await runWith(slow404Fetch, { fetch: 10_000, total: 60 }, async () => {
    await expect(fetchDlsiteData('RJ01527759')).rejects.toThrow(
      'DLsite request failed: upstream timeout'
    )
    // RJ 候选站 5 个 × 每站 3 跳 = 15 次串行请求，预算必须在跑满前收口
    expect(fetchCount).toBeLessThan(15)
  })
})

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

test('an upstream timeout surfaces as 502, never 404', async () => {
  await runWith(hangingFetch, { fetch: 20, total: 10_000 }, async () => {
    const res = createRes()
    await handleRequest(REQ, res as unknown as ServerResponse)

    // 404 会被 TouchGal 持久化，一次上游抖动就把真实作品永久标记成不存在
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
    await Promise.resolve()
    expect(fetchCount).toBe(1)

    res.emit('close')
    // 没有中止的话这里要挂到 10s 的单跳预算，且还会往死连接上写一次
    await expect(pending).resolves.toBeUndefined()
    expect(res.statusCode).toBe(0)
    expect(res.body).toBe('')
  })
})
