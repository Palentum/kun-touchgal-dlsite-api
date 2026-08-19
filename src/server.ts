import type { IncomingMessage, ServerResponse } from 'node:http'
import { fetchDlsiteData } from './dlsite'

const ALLOWED_CORS_HOSTS = new Set(['127.0.0.1', 'touchgal.top', 'touchgal.us'])
const REQUEST_BASE_URL = 'http://dlsite-api.internal'

type JsonValue = Record<string, unknown>

const resolveCorsOrigin = (req: IncomingMessage): string | undefined => {
  const origin = req.headers.origin
  if (!origin) return undefined
  try {
    const hostname = new URL(origin).hostname.toLowerCase()
    return ALLOWED_CORS_HOSTS.has(hostname) ? origin : undefined
  } catch {
    return undefined
  }
}

const applyCorsHeaders = (res: ServerResponse, origin?: string) => {
  if (!origin) return
  res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
}

export const sendJson = (
  res: ServerResponse,
  status: number,
  payload: JsonValue,
  origin?: string
) => {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  applyCorsHeaders(res, origin)
  res.end(JSON.stringify(payload))
}

// 基址不能取自 Host 头：它完全由客户端控制，畸形值会让 new URL 抛错。
// 路由只读 pathname 和 searchParams，基址取什么都不影响结果。
const getRequestUrl = (target: string): URL | null => {
  try {
    return new URL(target, REQUEST_BASE_URL)
  } catch {
    return null
  }
}

export const handleRequest = async (
  req: IncomingMessage,
  res: ServerResponse
) => {
  if (!req.url) {
    sendJson(res, 400, { error: 'INVALID_REQUEST' })
    return
  }

  const corsOrigin = resolveCorsOrigin(req)

  if (req.method === 'OPTIONS') {
    if (!corsOrigin) {
      sendJson(res, 403, { error: 'CORS_ORIGIN_FORBIDDEN' })
      return
    }
    applyCorsHeaders(res, corsOrigin)
    res.statusCode = 204
    res.end()
    return
  }

  const url = getRequestUrl(req.url)
  if (!url) {
    sendJson(res, 400, { error: 'INVALID_REQUEST' }, corsOrigin)
    return
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, { status: 'ok' }, corsOrigin)
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/dlsite') {
    const code = url.searchParams.get('code')
    if (!code) {
      sendJson(res, 400, { error: 'MISSING_CODE' }, corsOrigin)
      return
    }

    // 客户端挂断后继续抓取只是白占内存：把在途的上游请求和已解析的 DOM 一起放掉。
    // 'close' 在正常结束时也会触发，所以必须用 writableFinished 区分。
    const controller = new AbortController()
    res.on('close', () => {
      if (!res.writableFinished) controller.abort()
    })

    try {
      const data = await fetchDlsiteData(code, controller.signal)
      sendJson(res, 200, { data }, corsOrigin)
    } catch (err) {
      // 已经断开的连接无处可写，也不该记成一次上游失败
      if (controller.signal.aborted) return
      const message =
        err instanceof Error ? err.message : 'DLSITE_API_ERROR_UNKNOWN'
      const status =
        message === 'DLSITE_PRODUCT_NOT_FOUND'
          ? 404
          : message.startsWith('DLsite request failed')
            ? 502
            : 500
      sendJson(res, status, { error: message }, corsOrigin)
    }
    return
  }

  sendJson(res, 404, { error: 'NOT_FOUND' }, corsOrigin)
}

export type { JsonValue }
