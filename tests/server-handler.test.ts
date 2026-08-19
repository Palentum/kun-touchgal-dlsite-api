import type { IncomingMessage, ServerResponse } from 'node:http'
import { expect, test } from 'vitest'
import { handleRequest } from '../src/server'

const createReq = (
  url: string | undefined,
  headers: Record<string, string> = {},
  method = 'GET'
) => ({ url, method, headers }) as unknown as IncomingMessage

const createRes = () => {
  const state = {
    statusCode: 0,
    body: '',
    setHeader: () => {},
    end(chunk?: string) {
      this.body = chunk ?? ''
    }
  }
  return { res: state as unknown as ServerResponse, state }
}

// 修复前这些 Host 值会被拼进 new URL 的基址并抛 ERR_INVALID_URL，进而打死进程。
const MALFORMED_HOSTS = ['', ']', '::1', 'a b', 'http://x', '[', '%%']

// 这些请求目标仍会让 new URL 抛错，必须被 getRequestUrl 的 try/catch 兜住。
const THROWING_TARGETS = ['//', '/\\]', '/\\[', '/\\@', '/\\999.999.999.999']

// 三种写法都会把 authority 吞进 URL，pathname 同为 /health。
const AUTHORITY_TARGETS = [
  '//evil.com/health',
  '/\\evil.com/health',
  'http://evil.com/health'
]

test.each(MALFORMED_HOSTS)('malformed Host %j is ignored', async (host) => {
  const { res, state } = createRes()
  await handleRequest(createReq('/health', { host }), res)
  expect(state.statusCode).toBe(200)
  expect(JSON.parse(state.body)).toEqual({ status: 'ok' })
})

test.each(THROWING_TARGETS)(
  'unparsable target %j yields 400',
  async (target) => {
    const { res, state } = createRes()
    await expect(
      handleRequest(createReq(target, { host: '127.0.0.1:8787' }), res)
    ).resolves.toBeUndefined()
    expect(state.statusCode).toBe(400)
    expect(JSON.parse(state.body)).toEqual({ error: 'INVALID_REQUEST' })
  }
)

test.each(AUTHORITY_TARGETS)('target %j routes by pathname', async (target) => {
  const { res, state } = createRes()
  await handleRequest(createReq(target, {}), res)
  expect(state.statusCode).toBe(200)
})

test('existing routes keep their status codes', async () => {
  const missingCode = createRes()
  await handleRequest(createReq('/api/dlsite', {}), missingCode.res)
  expect(missingCode.state.statusCode).toBe(400)
  expect(JSON.parse(missingCode.state.body)).toEqual({ error: 'MISSING_CODE' })

  const notFound = createRes()
  await handleRequest(createReq('/nope', {}), notFound.res)
  expect(notFound.state.statusCode).toBe(404)

  const forbiddenPreflight = createRes()
  await handleRequest(
    createReq('/health', {}, 'OPTIONS'),
    forbiddenPreflight.res
  )
  expect(forbiddenPreflight.state.statusCode).toBe(403)

  const allowedPreflight = createRes()
  await handleRequest(
    createReq('/health', { origin: 'https://touchgal.top' }, 'OPTIONS'),
    allowedPreflight.res
  )
  expect(allowedPreflight.state.statusCode).toBe(204)
})
