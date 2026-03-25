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
}

const routeMap: Record<RouteKey, RouteMock> = {
  'maniax/RJ01527759': { html: htmlCache.RJ01527759 },
  'maniax/RJ01527748': { html: htmlCache.RJ01527759 },
  'maniax/RJ01341035': { html: htmlCache.RJ01341035, redirectSite: 'ai' },
  'ai/RJ01341035': { html: htmlCache.RJ01341035 },
  'maniax/RJ01466244': { html: htmlCache.RJ01466244, redirectSite: 'aix' },
  'aix/RJ01466244': { html: htmlCache.RJ01466244 },
  'appx/RJ01068983': { html: APPX_HTML },
  'pro/VJ01002419': { html: htmlCache.VJ01002419 }
}

const mockFetch = async (input: RequestInfo | URL): Promise<Response> => {
  const target =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url
  const url = new URL(target)
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
    finalUrl = finalUrl.replace(`/${site}/`, `/${route.redirectSite}/`)
  }

  return new MockResponse(route.html, finalUrl)
}

const runWithMockedFetch = async (fn: () => Promise<void>) => {
  const original = globalThis.fetch
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

test('supports VJ catalog entries', async () => {
  await runWithMockedFetch(async () => {
    const data = await fetchDlsiteData('VJ01002419')
    expect(data.title_default).toBe('美少女万華鏡異聞 雪おんな')
    expect(data.circle_name).toBe('ωstar')
    expect(data.release_date).toBe('2024-06-28')
    expect(data.circle_link).toContain('/pro/circle/profile')
  })
})
