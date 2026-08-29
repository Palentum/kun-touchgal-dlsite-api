import { expect, test, vi } from 'vitest'

// 钉住 parseChain 的 `run.catch(() => {})` 尾巴:linkedom 抛一次错之后,
// 串行解析链必须还活着。没有那个 catch,链尾停在 rejected 上,之后所有
// 走 HTML 解析的请求都立刻继承同一个陈旧错误,直到进程重启。
const parseFault = vi.hoisted(() => ({ armed: false }))

vi.mock('linkedom', async () => {
  const actual = await vi.importActual<typeof import('linkedom')>('linkedom')
  return {
    ...actual,
    parseHTML: (html: string) => {
      if (parseFault.armed) {
        parseFault.armed = false
        throw new Error('LINKEDOM_PARSE_FAULT')
      }
      return actual.parseHTML(html)
    }
  }
})

const { fetchDlsiteData } = await import('../src/dlsite')

const PRO_HTML = `
<!doctype html>
<html lang="zh-CN">
  <body>
    <h1 id="work_name">测试作品</h1>
    <table id="work_outline">
      <tr>
        <th>贩卖日</th>
        <td><a href="https://www.dlsite.com/pro/new/=/year/2024/mon/01/day/01">2024年01月01日</a></td>
      </tr>
    </table>
  </body>
</html>
`

// 回显请求 URL(带 ?locale=)让跳转循环一次通过;内容对每个 URL 都一样,
// 这个测试只关心解析层,不关心路由
const mockFetch = async (input: RequestInfo | URL): Promise<Response> =>
  ({
    status: 200,
    statusText: 'OK',
    ok: true,
    url: String(input),
    headers: new Headers(),
    text: async () => PRO_HTML,
    json: async () => []
  }) as unknown as Response

test('one parse failure must not break the chain for later requests', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = mockFetch as typeof globalThis.fetch
  let guardTimer: ReturnType<typeof setTimeout> | undefined
  try {
    // VJ 前缀只有 pro 一个候选:一次解析失败就让请求整体失败,不会被下一个
    // 候选的成功解析盖掉。错误原样浮出(500),而不是可缓存的 NOT_FOUND
    parseFault.armed = true
    await expect(fetchDlsiteData('VJ01000001')).rejects.toThrow(
      'LINKEDOM_PARSE_FAULT'
    )

    // 断链的主形态是立即失败(链尾 rejected,guard 不会触发);guard 兜住
    // 挂起形态的变异,免得只能等 vitest 超时才知道链卡住了
    const guard = new Promise<never>((_, reject) => {
      guardTimer = setTimeout(
        () =>
          reject(
            new Error('parse chain is stuck — was run.catch dropped from it?')
          ),
        1000
      )
    })
    const next = await Promise.race([fetchDlsiteData('VJ01000002'), guard])
    expect(next.title_default).toBe('测试作品')
  } finally {
    clearTimeout(guardTimer)
    globalThis.fetch = originalFetch
  }
})
