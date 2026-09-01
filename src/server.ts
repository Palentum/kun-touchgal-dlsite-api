import type { IncomingMessage, ServerResponse } from 'node:http'
import { fetchDlsiteData } from './dlsite'
import { tryAcquire } from './gate'

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

  // HEAD 是拨测/LB 健康检查的默认方法；node:http 对 HEAD 自动丢弃响应体，
  // sendJson 无需感知。/api/dlsite 刻意不放行 HEAD——为丢弃的响应体烧一次
  // 最长 30 s 的抓取加一个闸门槽位不值得。
  if (
    (req.method === 'GET' || req.method === 'HEAD') &&
    url.pathname === '/health'
  ) {
    sendJson(res, 200, { status: 'ok' }, corsOrigin)
    return
  }

  if (req.method === 'GET' && url.pathname === '/api/dlsite') {
    const code = url.searchParams.get('code')
    if (!code) {
      sendJson(res, 400, { error: 'MISSING_CODE' }, corsOrigin)
      return
    }

    // 只有真正要去抓取的请求才占槽位；/health 与上面的参数校验都不进闸门，
    // 饱和时探针必须仍能应答，否则 LB / pm2 会误判进程已死。
    const release = tryAcquire()
    if (!release) {
      res.setHeader('Retry-After', '1')
      sendJson(res, 503, { error: 'SERVICE_BUSY' }, corsOrigin)
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
      // code 的格式问题是调用方的错，不是上游的 —— 落进默认的 500 会让
      // TouchGal 把一次自己的拼写错误当成本服务故障去重试。
      const status =
        message === 'DLSITE_CODE_INVALID' || message === 'DLSITE_CODE_EMPTY'
          ? 400
          : message === 'DLSITE_PRODUCT_NOT_FOUND'
            ? 404
            : message.startsWith('DLsite request failed')
              ? 502
              : 500
      sendJson(res, status, { error: message }, corsOrigin)
    } finally {
      // 中止路径在 catch 里提前 return，槽位仍然要还回去
      release()
    }
    return
  }

  sendJson(res, 404, { error: 'NOT_FOUND' }, corsOrigin)
}

export type { JsonValue }
