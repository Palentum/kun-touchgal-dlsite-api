import { createServer } from 'node:http'
import { handleRequest, sendJson } from './server'

const DEFAULT_PORT = Number.parseInt(process.env.PORT ?? '8787', 10)
// 必须用 ||：HOST='' 是 falsy 但不是 nullish，?? 会放行，
// 而 listen(port, '') 走的是「未指定 host」分支，静默绑定通配地址。
const DEFAULT_HOST = process.env.HOST || '127.0.0.1'

const server = createServer((req, res) => {
  // node:http 不会 await requestListener 返回的 promise，
  // 少了这个 catch，处理函数里任何抛出都会变成 unhandled rejection 并杀死进程。
  handleRequest(req, res).catch((err) => {
    console.error('Unhandled request error', err)
    if (res.headersSent) {
      res.end()
      return
    }
    sendJson(res, 500, { error: 'INTERNAL_ERROR' })
  })
})

server.listen(DEFAULT_PORT, DEFAULT_HOST, () => {
  console.log(
    `DLsite API server listening on http://${DEFAULT_HOST}:${DEFAULT_PORT}`
  )
})

export type { JsonValue } from './server'
