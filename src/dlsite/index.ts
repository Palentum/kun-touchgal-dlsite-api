import { parseHTML } from 'linkedom'
import {
  DL_SUPPORTED_LOCALES,
  DLSITE_API_BASE,
  REQUEST_HEADERS,
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

const createRequestInit = (): RequestInit => ({
  headers: {
    ...REQUEST_HEADERS,
    Cookie: ADULT_COOKIE
  },
  redirect: 'follow' as RequestRedirect,
  cache: 'no-store'
})

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
  fallbackSite: DlsiteSite
): Promise<DocumentResult | null> => {
  const response = await fetch(url, createRequestInit())
  if (response.status === 404) {
    return null
  }

  if (!response.ok) {
    throw new Error(
      `DLsite request failed: ${response.status} ${response.statusText}`
    )
  }

  const html = await response.text()
  const finalUrl = response.url || url
  const site = detectSiteFromUrl(finalUrl) ?? fallbackSite

  return {
    document: parseHtmlDocument(html),
    site,
    url: finalUrl
  }
}

const fetchSecondaryDocument = async (
  url: string,
  primary: DocumentResult
): Promise<Document | null> => {
  if (url === primary.url) {
    return primary.document
  }
  const doc = await requestDocument(url, primary.site)
  return doc?.document ?? null
}

const fetchDocumentForSite = async (
  code: string,
  locale: DlsiteLocale,
  site: DlsiteSite
): Promise<DocumentResult | null> => {
  let currentSite = site
  for (let hop = 0; hop < 3; hop += 1) {
    const requestUrl = buildProductUrl(code, locale, currentSite)
    const result = await requestDocument(requestUrl, currentSite)
    if (!result) {
      return null
    }
    const finalLocale = getLocaleFromUrl(result.url)
    if (result.site === currentSite && finalLocale === locale) {
      return result
    }
    currentSite = result.site
  }
  return null
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
  sites: DlsiteSite[]
): Promise<ApiProductData | null> => {
  for (const site of sites) {
    const url = `${DLSITE_API_BASE[site]}?workno=${code}&locale=${locale}`
    const response = await fetch(url, createRequestInit())
    if (!response.ok) continue

    const data = (await response.json()) as ApiProductData[]
    if (data?.[0]) return data[0]
  }
  return null
}

const fetchDlsiteDataFromApi = async (
  code: string,
  candidateSites: DlsiteSite[]
): Promise<DlsiteApiResponse> => {
  const [dataCn, dataJp, dataEn] = await Promise.all([
    fetchProductApi(code, DL_SUPPORTED_LOCALES.cn, candidateSites),
    fetchProductApi(code, DL_SUPPORTED_LOCALES.jp, candidateSites),
    fetchProductApi(code, DL_SUPPORTED_LOCALES.en, candidateSites)
  ])

  if (!dataCn && !dataJp) {
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
  code: string
): Promise<DlsiteApiResponse> => {
  const normalizedCode = normalizeDlsiteCode(code)
  const candidateSites = getCandidateSites(normalizedCode)

  let primaryDoc: DocumentResult | null = null
  for (const site of candidateSites) {
    primaryDoc = await fetchDocumentForSite(
      normalizedCode,
      DL_SUPPORTED_LOCALES.cn,
      site
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
    return fetchDlsiteDataFromApi(normalizedCode, candidateSites)
  }

  const releaseDate = extractReleaseDate(docCn)
  const tags = extractTags(docCn)
  const circleInfo = extractCircle(docCn)
  const editionLinks = extractEditionLinks(docCn)

  const jpUrl = ensureLocaleUrl(
    editionLinks.jp ?? undefined,
    DL_SUPPORTED_LOCALES.jp,
    normalizedCode,
    primaryDoc.site
  )
  const enUrl = ensureLocaleUrl(
    editionLinks.en ?? undefined,
    DL_SUPPORTED_LOCALES.en,
    normalizedCode,
    primaryDoc.site
  )

  const [docJp, docEn] = await Promise.all([
    fetchSecondaryDocument(jpUrl, primaryDoc),
    fetchSecondaryDocument(enUrl, primaryDoc)
  ])

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
