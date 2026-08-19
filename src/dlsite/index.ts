import { parseHTML } from 'linkedom'
import {
  DL_SUPPORTED_LOCALES,
  DLSITE_API_BASE,
  FETCH_TIMEOUT_MS,
  REQUEST_HEADERS,
  TOTAL_TIMEOUT_MS,
  ADULT_COOKIE
} from './constants'
import {
  extractCircle,
  extractEditionLinks,
  extractReleaseDate,
  extractTags,
  extractTitle
} from './parsers'
import type { DlsiteApiResponse, DlsiteLocale, DlsiteSite } from './types'
import {
  buildProductUrl,
  cleanDlsiteTitle,
  detectSiteFromUrl,
  ensureLocaleUrl,
  getCandidateSites,
  normalizeDlsiteCode
} from './utils'

interface DocumentResult {
  document: Document
  site: DlsiteSite
  url: string
}

// 每跳上限与整次调用的预算取「先到者」。少了 signal，挂起的上游会一路占住入站
// socket 和已解析的 DOM 直到 undici 的 300s 兜底 —— 串行探测会把它乘到小时级。
const createRequestInit = (deadline: AbortSignal): RequestInit => ({
  headers: {
    ...REQUEST_HEADERS,
    Cookie: ADULT_COOKIE
  },
  redirect: 'follow' as RequestRedirect,
  cache: 'no-store',
  signal: AbortSignal.any([AbortSignal.timeout(FETCH_TIMEOUT_MS), deadline])
})

const isAbortError = (err: unknown): boolean =>
  err instanceof DOMException &&
  (err.name === 'TimeoutError' || err.name === 'AbortError')

// 超时不是「这个 section 不带这个作品」。中止异常原样抛出会落到 server.ts 的 500
// 分支，而这里必须复用 `DLsite request failed` 前缀走 502：调用方会缓存 404。
const toUpstreamError = (err: unknown): Error =>
  isAbortError(err)
    ? new Error('DLsite request failed: upstream timeout')
    : err instanceof Error
      ? err
      : new Error(String(err))

const parseHtmlDocument = (html: string): Document => parseHTML(html).document

const getLocaleFromUrl = (url: string): string | null => {
  try {
    return new URL(url).searchParams.get('locale')
  } catch {
    return null
  }
}

const requestDocument = async (
  url: string,
  fallbackSite: DlsiteSite,
  deadline: AbortSignal
): Promise<DocumentResult | null> => {
  try {
    const response = await fetch(url, createRequestInit(deadline))
    if (response.status === 404) {
      return null
    }

    if (!response.ok) {
      throw new Error(
        `DLsite request failed: ${response.status} ${response.statusText}`
      )
    }

    // body 读取同样受 signal 约束，所以一并留在 try 里
    const html = await response.text()
    const finalUrl = response.url || url
    const site = detectSiteFromUrl(finalUrl) ?? fallbackSite

    return {
      document: parseHtmlDocument(html),
      site,
      url: finalUrl
    }
  } catch (err) {
    throw toUpstreamError(err)
  }
}

const fetchSecondaryDocument = async (
  url: string,
  primary: DocumentResult,
  deadline: AbortSignal
): Promise<Document | null> => {
  if (url === primary.url) {
    return primary.document
  }
  const doc = await requestDocument(url, primary.site, deadline)
  return doc?.document ?? null
}

// DLsite redirects works to whichever section owns them — including sections
// this service has no constant for (bl, books, …) — and drops ?locale= on the
// way. Retry against the *resolved* URL so section names never have to be known.
const withLocale = (url: string, locale: DlsiteLocale): string | null => {
  try {
    const parsed = new URL(url)
    const isDlsite =
      parsed.hostname === 'dlsite.com' ||
      parsed.hostname.endsWith('.dlsite.com')
    if (!isDlsite) return null
    parsed.searchParams.set('locale', locale)
    return parsed.toString()
  } catch {
    return null
  }
}

const fetchDocumentForSite = async (
  code: string,
  locale: DlsiteLocale,
  site: DlsiteSite,
  deadline: AbortSignal
): Promise<DocumentResult | null> => {
  let requestUrl = buildProductUrl(code, locale, site)
  let currentSite = site
  const attempted = new Set<string>()
  let result: DocumentResult | null = null

  for (let hop = 0; hop < 3; hop += 1) {
    attempted.add(requestUrl)
    result = await requestDocument(requestUrl, currentSite, deadline)
    if (!result) {
      return null
    }
    if (getLocaleFromUrl(result.url) === locale) {
      break
    }

    const next = withLocale(result.url, locale)
    if (!next || attempted.has(next)) {
      break
    }
    requestUrl = next
    currentSite = result.site
  }

  // Whatever the loop settled on — including a wrong-locale page or the hop cap
  // — beats reporting a 404 for a product whose page is already in hand
  return result
}

interface ApiProductData {
  work_name?: string
  maker_name?: string
  maker_name_en?: string
  maker_id?: string
  regist_date?: string
  genres?: Array<{ name: string }>
  site_id?: string
}

const fetchProductApi = async (
  code: string,
  locale: DlsiteLocale,
  sites: DlsiteSite[],
  deadline: AbortSignal
): Promise<ApiProductData | null> => {
  for (const site of sites) {
    const url = `${DLSITE_API_BASE[site]}?workno=${code}&locale=${locale}`
    try {
      const response = await fetch(url, createRequestInit(deadline))
      // Only 404 means this section doesn't carry the work. Collapsing 403/429/5xx
      // into a cacheable "not found" makes callers record a real work as missing.
      if (response.status === 404) continue
      if (!response.ok) {
        throw new Error(
          `DLsite request failed: ${response.status} ${response.statusText}`
        )
      }

      const data = (await response.json()) as ApiProductData[]
      if (data?.[0]) return data[0]
    } catch (err) {
      throw toUpstreamError(err)
    }
  }
  return null
}

const fetchDlsiteDataFromApi = async (
  code: string,
  candidateSites: DlsiteSite[],
  deadline: AbortSignal
): Promise<DlsiteApiResponse> => {
  // allSettled, not all: a lone en failure must not discard usable cn/jp data —
  // the rejection only decides the outcome when both cn and jp came back empty
  const results = await Promise.allSettled([
    fetchProductApi(code, DL_SUPPORTED_LOCALES.cn, candidateSites, deadline),
    fetchProductApi(code, DL_SUPPORTED_LOCALES.jp, candidateSites, deadline),
    fetchProductApi(code, DL_SUPPORTED_LOCALES.en, candidateSites, deadline)
  ])
  const [dataCn, dataJp, dataEn] = results.map((result) =>
    result.status === 'fulfilled' ? result.value : null
  )

  if (!dataCn && !dataJp) {
    const failed = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    )
    if (failed) throw failed.reason
    throw new Error('DLSITE_PRODUCT_NOT_FOUND')
  }

  const primary = dataCn ?? dataJp!
  const titleCn = cleanDlsiteTitle(dataCn?.work_name)
  const titleJp = cleanDlsiteTitle(dataJp?.work_name)
  const titleEn = cleanDlsiteTitle(dataEn?.work_name)

  const releaseDate = primary.regist_date
    ? primary.regist_date.slice(0, 10)
    : undefined

  const tags = primary.genres?.map((g) => g.name).join(',') || undefined

  const makerId = primary.maker_id
  const siteId = primary.site_id ?? candidateSites[0]
  const circleLink = makerId
    ? `https://www.dlsite.com/${siteId}/circle/profile/=/maker_id/${makerId}.html`
    : undefined

  return {
    rj_code: code,
    title_default: titleCn || titleJp || code,
    title_jp: titleJp || undefined,
    title_en: titleEn || undefined,
    release_date: releaseDate,
    tags,
    circle_name: primary.maker_name?.trim() || undefined,
    circle_link: circleLink
  }
}

export const fetchDlsiteData = async (
  code: string,
  external?: AbortSignal
): Promise<DlsiteApiResponse> => {
  const normalizedCode = normalizeDlsiteCode(code)
  const candidateSites = getCandidateSites(normalizedCode)

  // 一次调用一个预算，覆盖串行候选探测的累加；external 让调用方在客户端断连时收摊
  const budget = AbortSignal.timeout(TOTAL_TIMEOUT_MS)
  const deadline = external ? AbortSignal.any([budget, external]) : budget

  let primaryDoc: DocumentResult | null = null
  for (const site of candidateSites) {
    primaryDoc = await fetchDocumentForSite(
      normalizedCode,
      DL_SUPPORTED_LOCALES.cn,
      site,
      deadline
    )
    if (primaryDoc) {
      break
    }
  }

  if (!primaryDoc) {
    throw new Error('DLSITE_PRODUCT_NOT_FOUND')
  }

  const docCn = primaryDoc.document

  // SPA pages (e.g. aix) lack server-rendered metadata — fall back to JSON API
  if (!docCn.querySelector('#work_outline')) {
    return fetchDlsiteDataFromApi(normalizedCode, candidateSites, deadline)
  }

  const releaseDate = extractReleaseDate(docCn)
  const tags = extractTags(docCn)
  const circleInfo = extractCircle(docCn)
  const editionLinks = extractEditionLinks(docCn)

  // Fall back to the resolved primary URL, not the requested site — the page may
  // live in a section with no DLSITE_PRODUCT_BASE entry
  const jpUrl = ensureLocaleUrl(
    editionLinks.jp ?? primaryDoc.url,
    DL_SUPPORTED_LOCALES.jp,
    normalizedCode,
    primaryDoc.site
  )
  const enUrl = ensureLocaleUrl(
    editionLinks.en ?? primaryDoc.url,
    DL_SUPPORTED_LOCALES.en,
    normalizedCode,
    primaryDoc.site
  )

  // allSettled，不用 all：jp/en 只贡献本地化标题。一个慢到超时或 5xx 的版本页
  // 不该把已经抓好的 cn 数据整个丢掉 —— 与 product.json 路径同一处理
  const [docJp, docEn] = (
    await Promise.allSettled([
      fetchSecondaryDocument(jpUrl, primaryDoc, deadline),
      fetchSecondaryDocument(enUrl, primaryDoc, deadline)
    ])
  ).map((result) => (result.status === 'fulfilled' ? result.value : null))

  const cleanTitle = (document: Document | null): string | undefined => {
    const raw = extractTitle(document)
    const cleaned = cleanDlsiteTitle(raw)
    return cleaned || undefined
  }

  const result: DlsiteApiResponse = {
    rj_code: normalizedCode,
    title_default: cleanTitle(docCn) || normalizedCode,
    title_jp: cleanTitle(docJp),
    title_en: cleanTitle(docEn),
    release_date: releaseDate,
    tags,
    circle_name: circleInfo.name?.trim() || undefined,
    circle_link: circleInfo.link
  }

  return result
}

export type { DlsiteApiResponse } from './types'
