import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from 'vitest'
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
  'pro/VJ01002419': { html: htmlCache.VJ01002419 }
}

let fetchCount = 0
const requestedUrls = new Set<string>()

const mockFetch = async (input: RequestInfo | URL): Promise<Response> => {
  fetchCount += 1
  const target =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url
  const url = new URL(target)
  requestedUrls.add(url.toString())
  const match = url.pathname.match(
    /\/([^/]+)\/work\/=\/product_id\/([A-Za-z]{2}\d+)/
  )
  if (!match) {
    throw new Error(`Unhandled DLsite request: ${url.toString()}`)
  }

  const [, site, code] = match
  const key = `${site}/${code.toUpperCase()}` as RouteKey
  const route = routeMap[key]
  if (!route) {
    return new MockResponse('', url.toString(), 404, 'Not Found')
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
  globalThis.fetch = mockFetch as typeof globalThis.fetch
  try {
    await fn()
  } finally {
    globalThis.fetch = original
  }
}

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

test('supports VJ catalog entries', async () => {
  await runWithMockedFetch(async () => {
    const data = await fetchDlsiteData('VJ01002419')
    expect(data.title_default).toBe('美少女万華鏡異聞 雪おんな')
    expect(data.circle_name).toBe('ωstar')
    expect(data.release_date).toBe('2024-06-28')
    expect(data.circle_link).toContain('/pro/circle/profile')
  })
})
