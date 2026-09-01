import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { fetchDlsiteData } from '../src/dlsite'

class MockResponse implements Response {
  readonly status: number
  readonly statusText: string
  readonly ok: boolean
  readonly url: string
  readonly headers = new Headers()
  readonly redirected = false
  readonly type: ResponseType = 'basic'
  readonly body: ReadableStream<Uint8Array<ArrayBuffer>> | null = null
  readonly bodyUsed = true
  #body: string

  constructor(body: string, url: string, status = 200, statusText = 'OK') {
    this.#body = body
    this.url = url
    this.status = status
    this.statusText = statusText
    this.ok = status >= 200 && status < 300
  }

  clone(): Response {
    return new MockResponse(this.#body, this.url, this.status, this.statusText)
  }

  async text(): Promise<string> {
    return this.#body
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    const encoded = new TextEncoder().encode(this.#body)
    const buffer = new ArrayBuffer(encoded.byteLength)
    new Uint8Array(buffer).set(encoded)
    return buffer
  }

  async blob(): Promise<Blob> {
    throw new Error('Not implemented')
  }

  async bytes(): Promise<Uint8Array<ArrayBuffer>> {
    return new TextEncoder().encode(this.#body) as Uint8Array<ArrayBuffer>
  }

  async formData(): Promise<FormData> {
    throw new Error('Not implemented')
  }

  async json(): Promise<unknown> {
    return JSON.parse(this.#body)
  }
}

// headers 之后连接被重置：status 维度表达不了这种失败 —— response.ok 已经
// 通过，问题要到 text() 读 body 时才暴露，undici 抛 TypeError('terminated')
class TerminatedBodyResponse extends MockResponse {
  async text(): Promise<string> {
    throw Object.assign(new TypeError('terminated'), {
      cause: Object.assign(new Error('other side closed'), {
        code: 'UND_ERR_SOCKET'
      })
    })
  }
}

const metaDir = resolve(process.cwd(), 'meta')

const readMeta = (filename: string) =>
  readFileSync(resolve(metaDir, filename), 'utf8')

const APPX_HTML = `
<!doctype html>
<html lang="zh-CN">
  <body>
    <h1 id="work_name">神待ちサナちゃん</h1>
    <table id="work_outline">
      <tr>
        <th>贩卖日</th>
        <td><a href="https://www.dlsite.com/appx/new/=/year/2024/mon/08/day/30">2024年08月30日</a></td>
      </tr>
      <tr>
        <th>メーカー</th>
        <td id="work_maker">
          <a href="https://www.dlsite.com/appx/circle/profile/=/maker_id/RG00000001.html">测试厂商</a>
        </td>
      </tr>
    </table>
    <div class="main_genre">
      <a href="/appx/fsr/=/genre/001">手机游戏</a>
      <a href="/appx/fsr/=/genre/002">RPG</a>
    </div>
  </body>
</html>
`

const GIRLS_HTML = `
<!doctype html>
<html lang="zh-CN">
  <body>
    <h1 id="work_name">王子様の耳元でおやすみ</h1>
    <table id="work_outline">
      <tr>
        <th>贩卖日</th>
        <td><a href="https://www.dlsite.com/girls/new/=/year/2018/mon/01/day/26">2018年01月26日</a></td>
      </tr>
      <tr>
        <th>社团名</th>
        <td id="work_maker">
          <a href="https://www.dlsite.com/girls/circle/profile/=/maker_id/RG13604.html">测试社团</a>
        </td>
      </tr>
    </table>
    <div class="main_genre">
      <a href="/girls/fsr/=/genre/001">乙女向</a>
      <a href="/girls/fsr/=/genre/002">治愈</a>
    </div>
  </body>
</html>
`

const BL_HTML = `
<!doctype html>
<html lang="zh-CN">
  <body>
    <h1 id="work_name">新騎生誕記念作品 弟のケツマンコ開発日記</h1>
    <table id="work_outline">
      <tr>
        <th>发售日</th>
        <td><a href="https://www.dlsite.com/bl/new/=/year/2023/mon/11/day/27">2023年11月27日</a></td>
      </tr>
      <tr>
        <th>社团名</th>
        <td id="work_maker">
          <a href="https://www.dlsite.com/bl/circle/profile/=/maker_id/RG54654.html">新騎の4回戦目</a>
        </td>
      </tr>
    </table>
    <div class="main_genre">
      <a href="/bl/fsr/=/genre/001">ASMR</a>
      <a href="/bl/fsr/=/genre/002">BL</a>
    </div>
  </body>
</html>
`

// BJ codes have no section of their own in the candidate list: maniax redirects
// them to /books/ and drops ?locale= on the way
const BOOKS_HTML = `
<!doctype html>
<html lang="zh-CN">
  <body>
    <h1 id="work_name">少女地獄 II</h1>
    <table id="work_outline">
      <tr>
        <th>发售日</th>
        <td><a href="https://www.dlsite.com/books/new/=/year/2008/mon/11/day/15">2008年11月15日</a></td>
      </tr>
      <tr>
        <th>社团名</th>
        <td id="work_maker">
          <a href="https://www.dlsite.com/books/author/=/author_id/AJ001591">オイスター</a>
        </td>
      </tr>
    </table>
    <div class="main_genre">
      <a href="/books/fsr/=/genre/001">羞辱</a>
      <a href="/books/fsr/=/genre/002">教育</a>
    </div>
  </body>
</html>
`

// Real aix pages are SPA shells with no server-rendered #work_outline — the only
// way into the product.json fallback
const SPA_SHELL_HTML = `
<!doctype html>
<html lang="zh-CN">
  <body><div id="app"></div></body>
</html>
`

const htmlCache = {
  RJ01527759: readMeta('RJ01527759_RJ.html'),
  RJ01341035: readMeta('RJ01341035_ai.html'),
  RJ01466244: readMeta('RJ01466244_aix.html'),
  VJ01002419: readMeta('VJ01002419_VJ.html')
}

type RouteKey = `${string}/${string}`

interface RouteMock {
  html: string
  redirectSite?: string
  // Real DLsite drops the ?locale= query on cross-section redirects (e.g. girls)
  dropLocaleOnRedirect?: boolean
  // Pathological section that never echoes back the requested locale
  dropLocaleAlways?: boolean
}

const routeMap: Record<RouteKey, RouteMock> = {
  'maniax/RJ01527759': { html: htmlCache.RJ01527759 },
  'maniax/RJ01341035': { html: htmlCache.RJ01341035, redirectSite: 'ai' },
  'ai/RJ01341035': { html: htmlCache.RJ01341035 },
  'maniax/RJ01466244': { html: htmlCache.RJ01466244, redirectSite: 'aix' },
  'aix/RJ01466244': { html: htmlCache.RJ01466244 },
  'appx/RJ01068983': { html: APPX_HTML },
  'maniax/RJ202395': {
    html: GIRLS_HTML,
    redirectSite: 'girls',
    dropLocaleOnRedirect: true
  },
  'girls/RJ202395': { html: GIRLS_HTML },
  'maniax/RJ01124081': {
    html: BL_HTML,
    redirectSite: 'bl',
    dropLocaleOnRedirect: true
  },
  'bl/RJ01124081': { html: BL_HTML },
  'maniax/RJ00000001': { html: BL_HTML, dropLocaleAlways: true },
  'maniax/RJ01999001': { html: SPA_SHELL_HTML },
  'pro/VJ01002419': { html: htmlCache.VJ01002419 },
  'maniax/BJ002248': {
    html: BOOKS_HTML,
    redirectSite: 'books',
    dropLocaleOnRedirect: true
  },
  'books/BJ002248': { html: BOOKS_HTML }
}

interface ApiMock {
  status: number
  statusText: string
  body: string
}

// Keyed workno/locale, section-agnostic: the candidate loop stops at the first
// non-404, so these cases exercise the status dimension
let apiRoutes: Record<string, ApiMock> = {}

const API_THROTTLED: ApiMock = {
  status: 429,
  statusText: 'Too Many Requests',
  body: ''
}

const API_FOUND: ApiMock = {
  status: 200,
  statusText: 'OK',
  body: JSON.stringify([
    {
      work_name: '孤独少女との50日間',
      maker_name: 'こんなに大きくなりました',
      maker_id: 'RG12345',
      regist_date: '2025-03-01 00:00:00',
      genres: [{ name: '少女' }, { name: '治愈' }],
      site_id: 'aix'
    }
  ])
}

let fetchCount = 0
const requestedUrls = new Set<string>()
// Serves 5xx for the given locale, to check one bad edition page can't sink the
// primary result
let failingLocales = new Set<string>()
// section → status its product pages answer with, regardless of code. A bot
// check on one section must not veto the remaining candidates, and the status
// dimension is what distinguishes which failure gets surfaced
let failingSites = new Map<string, number>()
// Same idea for product.json, 403 only. Kept separate from failingSites because
// reaching the JSON path at all requires the section's shell page to answer 200.
let forbiddenApiSites = new Set<string>()
// 该版块的 product.json 以 200+HTML 应答（WAF 挑战页/维护页）。status 维度表达
// 不了这种失败：response.ok 通过，问题要到 response.json() 解析时才暴露。
let htmlApiSites = new Set<string>()
// 该版块的产品页在传输层失败（DNS/TLS/ECONNREFUSED）：undici 把它们统一抛成
// TypeError('fetch failed')，底层错误挂在 cause 上 —— 没有 HTTP status，
// failingSites 的 status 维度表达不了
let transportFailingSites = new Set<string>()
// 该版块的产品页 200 后 body 中途断流，见 TerminatedBodyResponse
let terminatedBodySites = new Set<string>()
// code → status a non-dlsite.com landing answers with. DLsite redirects some BJ
// works off-host entirely; fetch follows that internally, so a single request
// comes back carrying the third party's status and URL.
let offsiteRedirects = new Map<string, number>()
// Recorded rather than asserted inline: an expect() thrown from inside the mock
// is swallowed by the allSettled around the jp/en edition fetches
const unsignedRequests: string[] = []

const mockFetch = async (
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> => {
  fetchCount += 1
  const target =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url
  const url = new URL(target)
  requestedUrls.add(url.toString())

  // Without a signal the only backstop is undici's 300s default headersTimeout
  if (!(init?.signal instanceof AbortSignal) || init.signal.aborted) {
    unsignedRequests.push(url.toString())
  }

  if (url.pathname.endsWith('/api/=/product.json')) {
    if (forbiddenApiSites.has(url.pathname.split('/')[1])) {
      return new MockResponse('', url.toString(), 403, 'Forbidden')
    }
    if (htmlApiSites.has(url.pathname.split('/')[1])) {
      return new MockResponse(
        '<!doctype html><html>challenge</html>',
        url.toString(),
        200,
        'OK'
      )
    }
    const workno = url.searchParams.get('workno') ?? ''
    const locale = url.searchParams.get('locale') ?? ''
    const mock = apiRoutes[`${workno}/${locale}`]
    if (!mock) {
      return new MockResponse('', url.toString(), 404, 'Not Found')
    }
    return new MockResponse(
      mock.body,
      url.toString(),
      mock.status,
      mock.statusText
    )
  }

  const match = url.pathname.match(
    /\/([^/]+)\/work\/=\/product_id\/([A-Za-z]{2}\d+)/
  )
  if (!match) {
    throw new Error(`Unhandled DLsite request: ${url.toString()}`)
  }

  const [, site, code] = match
  const offsiteStatus = offsiteRedirects.get(code.toUpperCase())
  if (offsiteStatus) {
    return new MockResponse(
      '',
      `https://www.comipo.app/product/${code.toUpperCase()}`,
      offsiteStatus,
      'Offsite'
    )
  }
  const failingStatus = failingSites.get(site)
  if (failingStatus) {
    return new MockResponse('', url.toString(), failingStatus, 'Upstream')
  }
  if (transportFailingSites.has(site)) {
    throw Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('getaddrinfo ENOTFOUND www.dlsite.com'), {
        code: 'ENOTFOUND'
      })
    })
  }
  if (terminatedBodySites.has(site)) {
    return new TerminatedBodyResponse('', url.toString())
  }
  const key = `${site}/${code.toUpperCase()}` as RouteKey
  const route = routeMap[key]
  if (!route) {
    return new MockResponse('', url.toString(), 404, 'Not Found')
  }

  if (failingLocales.has(url.searchParams.get('locale') ?? '')) {
    return new MockResponse('', url.toString(), 503, 'Service Unavailable')
  }

  let finalUrl = url.toString()
  if (route.redirectSite && route.redirectSite !== site) {
    const redirected = new URL(
      finalUrl.replace(`/${site}/`, `/${route.redirectSite}/`)
    )
    if (route.dropLocaleOnRedirect) {
      redirected.searchParams.delete('locale')
    }
    finalUrl = redirected.toString()
  }

  if (route.dropLocaleAlways) {
    const stripped = new URL(finalUrl)
    stripped.searchParams.delete('locale')
    finalUrl = stripped.toString()
  }

  return new MockResponse(route.html, finalUrl)
}

const runWithMockedFetch = async (fn: () => Promise<void>) => {
  const original = globalThis.fetch
  fetchCount = 0
  requestedUrls.clear()
  apiRoutes = {}
  failingLocales = new Set()
  failingSites = new Map()
  transportFailingSites = new Set()
  terminatedBodySites = new Set()
  forbiddenApiSites = new Set()
  htmlApiSites = new Set()
  offsiteRedirects = new Map()
  globalThis.fetch = mockFetch as typeof globalThis.fetch
  try {
    await fn()
  } finally {
    globalThis.fetch = original
  }
}

afterEach(() => {
  const seen = [...unsignedRequests]
  unsignedRequests.length = 0
  expect(seen).toEqual([])
})

test('parses RJ maniax pages correctly', async () => {
  await runWithMockedFetch(async () => {
    const data = await fetchDlsiteData('RJ01527759')
    expect(data.title_default).toBe(
      'JKフェラチオ！だぶるアニメ！ 教育係の雛子ちゃんとクーデレ匂いフェチの新人ルリちゃん♪'
    )
    expect(data.release_date).toBe('2026-01-02')
    expect(data.circle_name).toBe('Whisp')
    expect(data.circle_link).toContain('/maker_id/RG41088')
    // The page's work_edition_linklist type_body lists RJ01527748 — a different
    // work — and its "1,485 JPY" price text used to be read as a Japanese edition
    expect(
      [...requestedUrls].filter((url) => url.includes('RJ01527748'))
    ).toEqual([])
    expect(data.title_jp).toBe(data.title_default)
  })
})

test('detects AI site redirects', async () => {
  await runWithMockedFetch(async () => {
    const data = await fetchDlsiteData('RJ01341035')
    expect(data.title_default).toBe('叛逆の守護者')
    expect(data.circle_name).toBe('朧燕')
    expect(data.circle_link).toContain('/ai/circle/profile')
  })
})

test('detects AIx site redirects', async () => {
  await runWithMockedFetch(async () => {
    const data = await fetchDlsiteData('RJ01466244')
    expect(data.title_default).toBe('孤独少女との50日間')
    expect(data.circle_name).toBe('こんなに大きくなりました')
    expect(data.circle_link).toContain('/aix/circle/profile')
  })
})

test('supports RJ catalog entries hosted on appx', async () => {
  await runWithMockedFetch(async () => {
    const data = await fetchDlsiteData('RJ01068983')
    expect(data.rj_code).toBe('RJ01068983')
    expect(data.title_default).toBe('神待ちサナちゃん')
    expect(data.release_date).toBe('2024-08-30')
    expect(data.circle_name).toBe('测试厂商')
    expect(data.circle_link).toContain('/appx/circle/profile')
    expect(data.tags).toBe('手机游戏,RPG')
  })
})

test('follows redirects to the girls section (locale dropped on redirect)', async () => {
  await runWithMockedFetch(async () => {
    const data = await fetchDlsiteData('RJ202395')
    expect(data.rj_code).toBe('RJ202395')
    expect(data.title_default).toBe('王子様の耳元でおやすみ')
    expect(data.release_date).toBe('2018-01-26')
    expect(data.circle_name).toBe('测试社团')
    expect(data.circle_link).toContain('/girls/circle/profile')
    expect(data.tags).toBe('乙女向,治愈')
  })
})

test('follows redirects to sections outside the candidate list (bl)', async () => {
  await runWithMockedFetch(async () => {
    const data = await fetchDlsiteData('RJ01124081')
    expect(data.rj_code).toBe('RJ01124081')
    expect(data.title_default).toBe('新騎生誕記念作品 弟のケツマンコ開発日記')
    expect(data.release_date).toBe('2023-11-27')
    expect(data.circle_name).toBe('新騎の4回戦目')
    expect(data.circle_link).toContain('/bl/circle/profile')
    expect(data.tags).toBe('ASMR,BL')
  })
})

test('keeps probing candidates when the first section answers 403', async () => {
  await runWithMockedFetch(async () => {
    // maniax is the first candidate for every RJ code and the likeliest to trip
    // a Cloudflare bot check; letting it veto the rest hid every girls/ai/aix/appx work
    failingSites = new Map([['maniax', 403]])
    const data = await fetchDlsiteData('RJ202395')
    expect(data.title_default).toBe('王子様の耳元でおやすみ')
    expect(data.circle_link).toContain('/girls/circle/profile')
    expect([...requestedUrls].some((url) => url.includes('/girls/work/'))).toBe(
      true
    )
  })
})

test('reports an upstream failure when every candidate section fails', async () => {
  await runWithMockedFetch(async () => {
    failingSites = new Map(
      ['maniax', 'ai', 'aix', 'appx', 'girls'].map((site) => [site, 403])
    )
    // Degrading to DLSITE_PRODUCT_NOT_FOUND here would let one bad hour record a
    // real work as permanently nonexistent — 404 is cacheable to callers
    await expect(fetchDlsiteData('RJ202395')).rejects.toThrow(
      /^DLsite request failed: 403/
    )
    expect(fetchCount).toBe(5)
  })
})

test('surfaces the first failing candidate, not the last', async () => {
  await runWithMockedFetch(async () => {
    // maniax's 429 is the one worth reporting — it says "you are being
    // throttled". girls comes last, and its transient 503 used to overwrite it
    failingSites = new Map([
      ['maniax', 429],
      ['girls', 503]
    ])
    await expect(fetchDlsiteData('RJ202395')).rejects.toThrow(
      /^DLsite request failed: 429/
    )
  })
})

test('maps transport-layer failures to the 502 prefix, not a raw fetch failed', async () => {
  await runWithMockedFetch(async () => {
    transportFailingSites = new Set(['maniax', 'ai', 'aix', 'appx', 'girls'])
    // TypeError('fetch failed') 原样透传会绕过 server.ts 的前缀匹配落进 500，
    // 把「DLsite 不可达」报成本服务自身的故障。全锚定正则同时钉死：前缀
    // 正确、消息只嵌 cause.code、不携带底层错误文本。
    await expect(fetchDlsiteData('RJ202395')).rejects.toThrow(
      /^DLsite request failed: fetch failed \(ENOTFOUND\)$/
    )
    // 传输层失败即时返回，和 403 一样继续探测 —— 5 次，不是超时式的 1 次
    expect(fetchCount).toBe(5)
  })
})

test('keeps probing candidates when the first section fails at the transport layer', async () => {
  await runWithMockedFetch(async () => {
    transportFailingSites = new Set(['maniax'])
    const data = await fetchDlsiteData('RJ202395')
    expect(data.title_default).toBe('王子様の耳元でおやすみ')
    expect(data.circle_link).toContain('/girls/circle/profile')
  })
})

test('maps a body stream cut mid-read to the 502 prefix', async () => {
  await runWithMockedFetch(async () => {
    terminatedBodySites = new Set(['maniax', 'ai', 'aix', 'appx', 'girls'])
    // 200 之后断流走的是 text() 的 TypeError('terminated')，与 fetch 本身
    // 的失败是两条路径，必须分别钉住
    await expect(fetchDlsiteData('RJ202395')).rejects.toThrow(
      /^DLsite request failed: terminated \(UND_ERR_SOCKET\)$/
    )
  })
})

test('still reports a missing HTML-path product as not found', async () => {
  await runWithMockedFetch(async () => {
    // The 403 fix must not turn a genuine miss into a 502
    await expect(fetchDlsiteData('RJ00000404')).rejects.toThrow(
      'DLSITE_PRODUCT_NOT_FOUND'
    )
    // 5 candidate pages and nothing more: a 404 that stayed on dlsite.com must
    // not fan out into 3 locales x 5 sections of product.json
    expect(fetchCount).toBe(5)
  })
})

test('never issues the same request twice while following redirects', async () => {
  await runWithMockedFetch(async () => {
    await fetchDlsiteData('RJ01124081')
    // A no-op hop would refetch an identical URL until the hop cap is hit
    expect(requestedUrls.size).toBe(fetchCount)
  })
})

test('returns data when a section never echoes the requested locale', async () => {
  await runWithMockedFetch(async () => {
    const data = await fetchDlsiteData('RJ00000001')
    expect(data.title_default).toBe('新騎生誕記念作品 弟のケツマンコ開発日記')
    expect(data.release_date).toBe('2023-11-27')
  })
})

test('reports throttled product.json as an upstream failure, not a missing work', async () => {
  await runWithMockedFetch(async () => {
    apiRoutes = {
      'RJ01999001/zh_CN': API_THROTTLED,
      'RJ01999001/ja_JP': API_THROTTLED,
      'RJ01999001/en_US': API_THROTTLED
    }
    // Reporting DLSITE_PRODUCT_NOT_FOUND here makes callers that cache 404 record a
    // real work as permanently nonexistent
    await expect(fetchDlsiteData('RJ01999001')).rejects.toThrow(
      /^DLsite request failed: 429/
    )
    // 1 shell page + 5 candidate sections per locale. The amplification is the
    // deliberate cost of not letting the first section veto the rest; it is
    // bounded by the candidate list, and MAX_IN_FLIGHT / TOTAL_TIMEOUT_MS cap it
    expect(fetchCount).toBe(16)
  })
})

test('keeps probing product.json candidates when one section answers 403', async () => {
  await runWithMockedFetch(async () => {
    forbiddenApiSites = new Set(['maniax'])
    apiRoutes = {
      'RJ01999001/zh_CN': API_FOUND,
      'RJ01999001/ja_JP': API_FOUND,
      'RJ01999001/en_US': API_FOUND
    }
    // This path is the only one SPA/aix works ever take — a 403 on maniax's
    // product.json used to make them permanently unreachable
    const data = await fetchDlsiteData('RJ01999001')
    expect(data.title_default).toBe('孤独少女との50日間')
    expect(data.release_date).toBe('2025-03-01')
  })
})

test('reports a 200+HTML product.json as an upstream failure, not a 500', async () => {
  await runWithMockedFetch(async () => {
    htmlApiSites = new Set(['maniax', 'ai', 'aix', 'appx', 'girls'])
    // 原始 SyntaxError 既不匹配 server.ts 的 502 前缀（落进 500），又把上游
    // 响应体前缀回显给客户端。全锚定正则同时钉死两点：前缀正确、消息里
    // 没有响应体片段；(maniax) 钉死 ??= 保住的是首个候选的失败。
    await expect(fetchDlsiteData('RJ01999001')).rejects.toThrow(
      /^DLsite request failed: non-JSON product\.json \(maniax\)$/
    )
    // 1 个壳页 + 3 locale x 5 版块：解析失败和 403 一样继续探测，不提前放弃
    expect(fetchCount).toBe(16)
  })
})

test('keeps probing product.json candidates when one section answers 200+HTML', async () => {
  await runWithMockedFetch(async () => {
    htmlApiSites = new Set(['maniax'])
    apiRoutes = {
      'RJ01999001/zh_CN': API_FOUND,
      'RJ01999001/ja_JP': API_FOUND,
      'RJ01999001/en_US': API_FOUND
    }
    // maniax 的挑战页和它的 403 同类：瞬时返回、单版块局部，不许一票否决
    const data = await fetchDlsiteData('RJ01999001')
    expect(data.title_default).toBe('孤独少女との50日間')
    expect(data.release_date).toBe('2025-03-01')
  })
})

test('still reports a genuinely missing product as not found', async () => {
  await runWithMockedFetch(async () => {
    apiRoutes = {}
    await expect(fetchDlsiteData('RJ01999001')).rejects.toThrow(
      'DLSITE_PRODUCT_NOT_FOUND'
    )
  })
})

test('keeps the response when only a secondary locale fails', async () => {
  await runWithMockedFetch(async () => {
    apiRoutes = {
      'RJ01999001/zh_CN': API_FOUND,
      'RJ01999001/ja_JP': API_FOUND,
      'RJ01999001/en_US': API_THROTTLED
    }
    const data = await fetchDlsiteData('RJ01999001')
    expect(data.title_default).toBe('孤独少女との50日間')
    expect(data.title_en).toBeUndefined()
    expect(data.release_date).toBe('2025-03-01')
    expect(data.circle_link).toContain('/aix/circle/profile')
  })
})

test('falls back to jp data when the cn locale carries no entry', async () => {
  await runWithMockedFetch(async () => {
    apiRoutes = {
      'RJ01999001/ja_JP': API_FOUND
    }
    // zh_CN 缺席时 primary 必须落到 dataJp —— 没有这条用例，`dataCn ?? dataJp`
    // 变异成 `dataCn!` 全套仍然绿灯（实测存活），jp-only 作品在生产直接崩
    const data = await fetchDlsiteData('RJ01999001')
    expect(data.title_default).toBe('孤独少女との50日間')
    expect(data.title_jp).toBe('孤独少女との50日間')
    expect(data.title_en).toBeUndefined()
    expect(data.release_date).toBe('2025-03-01')
    // 钉住 circle_link 的 maker_id 段：toContain('/aix/circle/profile') 只
    // 覆盖 site 段，maker_id 拼错时曾无测试转红
    expect(data.circle_link).toBe(
      'https://www.dlsite.com/aix/circle/profile/=/maker_id/RG12345.html'
    )
  })
})

test('keeps the scraped page when only a secondary edition page fails', async () => {
  await runWithMockedFetch(async () => {
    failingLocales = new Set(['en_US'])
    // Promise.all here discarded a fully scraped zh_CN page over a 503 on the
    // en_US edition — the per-hop timeout makes that failure mode reachable in 10s
    const data = await fetchDlsiteData('RJ01527759')
    expect(data.title_default).toBe(
      'JKフェラチオ！だぶるアニメ！ 教育係の雛子ちゃんとクーデレ匂いフェチの新人ルリちゃん♪'
    )
    expect(data.release_date).toBe('2026-01-02')
    expect(data.title_jp).toBe(data.title_default)
    expect(data.title_en).toBeUndefined()
  })
})

test('supports BJ catalog entries via the books redirect', async () => {
  await runWithMockedFetch(async () => {
    // BJ's only candidate is maniax, which redirects to /books/ — a section with
    // no DLSITE_PRODUCT_BASE entry and no detectSiteFromUrl branch
    const data = await fetchDlsiteData('BJ002248')
    expect(data.rj_code).toBe('BJ002248')
    expect(data.title_default).toBe('少女地獄 II')
    expect(data.release_date).toBe('2008-11-15')
    expect(data.circle_name).toBe('オイスター')
    expect(data.tags).toBe('羞辱,教育')
  })
})

test('falls back to product.json when DLsite redirects the work off-host', async () => {
  await runWithMockedFetch(async () => {
    // Some BJ works redirect to comipo.app. A 404 from a third party is not
    // DLsite saying the work is missing, and 404 is cacheable to callers —
    // DLsite's own product.json still carries the data.
    offsiteRedirects = new Map([['BJ01389023', 404]])
    apiRoutes = {
      'BJ01389023/zh_CN': API_FOUND,
      'BJ01389023/ja_JP': API_FOUND,
      'BJ01389023/en_US': API_FOUND
    }
    const data = await fetchDlsiteData('BJ01389023')
    expect(data.rj_code).toBe('BJ01389023')
    expect(data.title_default).toBe('孤独少女との50日間')
    expect(data.release_date).toBe('2025-03-01')
  })
})

test('still reports not found when the off-host fallback finds nothing', async () => {
  await runWithMockedFetch(async () => {
    offsiteRedirects = new Map([['BJ00000404', 404]])
    apiRoutes = {}
    await expect(fetchDlsiteData('BJ00000404')).rejects.toThrow(
      'DLSITE_PRODUCT_NOT_FOUND'
    )
    // 1 page + 3 locales on BJ's single candidate. Without this the test also
    // passes when the fallback never runs at all
    expect(fetchCount).toBe(4)
  })
})

test('supports VJ catalog entries', async () => {
  await runWithMockedFetch(async () => {
    const data = await fetchDlsiteData('VJ01002419')
    expect(data.title_default).toBe('美少女万華鏡異聞 雪おんな')
    expect(data.circle_name).toBe('ωstar')
    expect(data.release_date).toBe('2024-06-28')
    expect(data.circle_link).toContain('/pro/circle/profile')
  })
})
