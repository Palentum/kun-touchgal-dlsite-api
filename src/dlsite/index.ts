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

// Per-hop ceiling and the call-wide budget, whichever fires first. With no
// signal at all a hung upstream holds the inbound socket and every parsed DOM
// until undici's 300s default — and serial probing multiplies that.
const createRequestInit = (deadline: AbortSignal): RequestInit => ({
  headers: {
    ...REQUEST_HEADERS,
    Cookie: ADULT_COOKIE
  },
  redirect: 'follow' as RequestRedirect,
  cache: 'no-store',
  signal: AbortSignal.any([AbortSignal.timeout(FETCH_TIMEOUT_MS), deadline])
})

// A timeout is not "this section doesn't carry the work". A raw DOMException
// falls through server.ts's message match to 500, and folding it into
// DLSITE_PRODUCT_NOT_FOUND would be worse still — 404 is cacheable, so one
// upstream stall would record a real work as permanently missing.
const toUpstreamError = (err: unknown): unknown =>
  err instanceof DOMException &&
  (err.name === 'TimeoutError' || err.name === 'AbortError')
    ? new Error('DLsite request failed: upstream timeout')
    : err

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

    // The signal aborts the body stream too, so this stays inside the try
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

const cleanTitle = (document: Document | null): string | undefined => {
  const raw = extractTitle(document)
  const cleaned = cleanDlsiteTitle(raw)
  return cleaned || undefined
}

// 取完标题就返回字符串，让整份次要 DOM 立刻变成垃圾。以前这里返回 Document，
// jp/en 两份要一直活到函数末尾的 cleanTitle —— 每请求同时驻留 3 份 DOM。
const fetchSecondaryTitle = async (
  url: string,
  primary: DocumentResult,
  deadline: AbortSignal
): Promise<string | undefined> => {
  if (url === primary.url) {
    return cleanTitle(primary.document)
  }
  const doc = await requestDocument(url, primary.site, deadline)
  return cleanTitle(doc?.document ?? null)
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

  // One budget per call, so serial candidate probing can't accumulate past it;
  // `external` lets the caller cut it short when the client hangs up
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

  // allSettled, not all — same reason as the product.json path: these two only
  // supply localized titles, so a slow or 5xx edition page must not discard an
  // already-scraped cn page
  const [titleJp, titleEn] = (
    await Promise.allSettled([
      fetchSecondaryTitle(jpUrl, primaryDoc, deadline),
      fetchSecondaryTitle(enUrl, primaryDoc, deadline)
    ])
  ).map((result) => (result.status === 'fulfilled' ? result.value : undefined))

  const result: DlsiteApiResponse = {
    rj_code: normalizedCode,
    title_default: cleanTitle(docCn) || normalizedCode,
    title_jp: titleJp,
    title_en: titleEn,
    release_date: releaseDate,
    tags,
    circle_name: circleInfo.name?.trim() || undefined,
    circle_link: circleInfo.link
  }

  return result
}

export type { DlsiteApiResponse } from './types'
