import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

interface PendingScrape {
  settled: boolean
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
}

const mockState = vi.hoisted(() => ({
  pending: [] as PendingScrape[],
  active: 0,
  maxActive: 0
}))

// 用挂起的 promise 顶住槽位，才能观察到「同时进入抓取的有几个」。
vi.mock('../src/dlsite', () => ({
  fetchDlsiteData: (_code: string, signal?: AbortSignal) => {
    mockState.active += 1
    mockState.maxActive = Math.max(mockState.maxActive, mockState.active)

    return new Promise((resolve, reject) => {
      const entry: PendingScrape = {
        settled: false,
        resolve: (value) => {
          if (entry.settled) return
          entry.settled = true
          mockState.active -= 1
          resolve(value)
        },
        reject: (reason) => {
          if (entry.settled) return
          entry.settled = true
          mockState.active -= 1
          reject(reason)
        }
      }
      mockState.pending.push(entry)
      signal?.addEventListener('abort', () => entry.reject(signal.reason))
    })
  }
}))

const { handleRequest } = await import('../src/server')
const { MAX_IN_FLIGHT } = await import('../src/gate')

const createReq = (url: string) =>
  ({ url, method: 'GET', headers: {} }) as unknown as IncomingMessage

const createRes = () => {
  const listeners: Record<string, Array<() => void>> = {}
  const state = {
    statusCode: 0,
    body: '',
    headers: {} as Record<string, string>,
    writableFinished: false,
    setHeader(name: string, value: string) {
      this.headers[name] = value
    },
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
  return { res: state as unknown as ServerResponse, state }
}

type ResState = ReturnType<typeof createRes>['state']

// handleRequest 在到达 await fetchDlsiteData 之前全程同步，所以同步循环发出的
// 请求会确定性地先占满槽位、再被拒。
const fire = (count: number) => {
  const states: ResState[] = []
  const calls: Promise<void>[] = []
  for (let i = 0; i < count; i += 1) {
    const { res, state } = createRes()
    states.push(state)
    calls.push(handleRequest(createReq(`/api/dlsite?code=RJ0${i}`), res))
  }
  return { states, calls }
}

const drain = async (calls: Promise<void>[]) => {
  for (const entry of mockState.pending) {
    entry.resolve({ rj_code: 'RJ01527759', title_default: 'x' })
  }
  await Promise.all(calls)
}

beforeEach(() => {
  mockState.pending = []
  mockState.active = 0
  mockState.maxActive = 0
})

// 闸门是模块级状态：任一断言在 drain 之前抛错就会漏掉槽位，后面的用例全部连带
// 失败。兜底放行并让 finally 跑完（setImmediate 之前会先清空微任务队列）。
afterEach(async () => {
  for (const entry of mockState.pending) entry.resolve({})
  await new Promise((resolve) => setImmediate(resolve))
})

test('caps in-flight scrapes and sheds the overflow with 503', async () => {
  const overflow = 4
  const { states, calls } = fire(MAX_IN_FLIGHT + overflow)

  expect(mockState.maxActive).toBe(MAX_IN_FLIGHT)
  expect(mockState.pending).toHaveLength(MAX_IN_FLIGHT)

  for (const state of states.slice(MAX_IN_FLIGHT)) {
    expect(state.statusCode).toBe(503)
    expect(JSON.parse(state.body)).toEqual({ error: 'SERVICE_BUSY' })
    expect(state.headers['Retry-After']).toBe('1')
  }

  await drain(calls)

  for (const state of states.slice(0, MAX_IN_FLIGHT)) {
    expect(state.statusCode).toBe(200)
  }
})

test('/health still answers while the gate is saturated', async () => {
  const { calls } = fire(MAX_IN_FLIGHT)
  expect(mockState.pending).toHaveLength(MAX_IN_FLIGHT)

  const { res, state } = createRes()
  await handleRequest(createReq('/health'), res)
  expect(state.statusCode).toBe(200)
  expect(JSON.parse(state.body)).toEqual({ status: 'ok' })

  await drain(calls)
})

test('a failed scrape returns its permit', async () => {
  const { res, state } = createRes()
  const call = handleRequest(createReq('/api/dlsite?code=RJ1'), res)
  mockState.pending[0].reject(new Error('DLsite request failed: 429 x'))
  await call
  expect(state.statusCode).toBe(502)

  mockState.pending = []
  const batch = fire(MAX_IN_FLIGHT)
  expect(mockState.pending).toHaveLength(MAX_IN_FLIGHT)
  expect(batch.states.every((s) => s.statusCode === 0)).toBe(true)

  await drain(batch.calls)
})

test('a client hang-up returns its permit', async () => {
  const { res, state } = createRes()
  const call = handleRequest(createReq('/api/dlsite?code=RJ1'), res)
  state.emit('close')
  await call
  // 连接已断，处理函数不该再往上面写任何东西
  expect(state.statusCode).toBe(0)
  expect(state.body).toBe('')

  mockState.pending = []
  const batch = fire(MAX_IN_FLIGHT)
  expect(mockState.pending).toHaveLength(MAX_IN_FLIGHT)
  expect(batch.states.every((s) => s.statusCode === 0)).toBe(true)

  await drain(batch.calls)
})
