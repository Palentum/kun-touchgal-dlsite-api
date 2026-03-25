import {
  DLSITE_HOST,
  DLSITE_PRODUCT_BASE,
  SUPPORTED_PREFIXES
} from './constants'
import type { DlsiteLocale, DlsiteSite } from './types'

export const normalizeDlsiteCode = (input: string): string => {
  const trimmed = input.trim().toUpperCase()
  if (!trimmed) {
    throw new Error('DLSITE_CODE_EMPTY')
  }

  if (SUPPORTED_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) {
    return trimmed
  }

  return `RJ${trimmed}`
}

export const detectSiteFromUrl = (url: string): DlsiteSite | undefined => {
  try {
    const parsed = new URL(url)
    if (parsed.hostname.includes('dlsite.com')) {
      if (parsed.pathname.includes('/appx/')) return 'appx'
      if (parsed.pathname.includes('/aix/')) return 'aix'
      if (parsed.pathname.includes('/ai/')) return 'ai'
      if (parsed.pathname.includes('/pro/')) return 'pro'
    }
  } catch {
    return undefined
  }
  return undefined
}

export const buildProductUrl = (
  code: string,
  locale: DlsiteLocale,
  site: DlsiteSite
) => `${DLSITE_PRODUCT_BASE[site]}/${code}.html?locale=${locale}`

export const getCandidateSites = (code: string): DlsiteSite[] => {
  if (code.startsWith('RJ')) {
    return ['maniax', 'ai', 'aix', 'appx']
  }
  if (code.startsWith('VJ')) {
    return ['pro']
  }
  return ['maniax']
}

export const resolveDlsiteLink = (
  href: string | null | undefined
): string | undefined => {
  if (!href) return undefined
  if (href.startsWith('//')) return `https:${href}`
  if (href.startsWith('/')) return `${DLSITE_HOST}${href}`
  return href
}

export const ensureLocaleUrl = (
  link: string | null | undefined,
  locale: DlsiteLocale,
  fallbackCode: string,
  site: DlsiteSite
): string => {
  const fallback = buildProductUrl(fallbackCode, locale, site)
  const resolved = resolveDlsiteLink(link)
  if (!resolved) return fallback

  try {
    const url = new URL(resolved)
    url.searchParams.set('locale', locale)
    return url.toString()
  } catch {
    return fallback
  }
}

export const cleanDlsiteTitle = (raw: string | undefined | null): string => {
  if (!raw) return ''
  return raw
    .replace(/(\[[^\]]*]|【[^】]*】)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}
