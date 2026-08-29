import {
  DLSITE_HOST,
  DLSITE_PRODUCT_BASE,
  SUPPORTED_PREFIXES
} from './constants'
import type { DlsiteLocale, DlsiteSite } from './types'

// 白名单必须卡在这里：code 会被插值进产品页路径和 product.json 的 query。
// `/` 和 `..` 活到 new URL 就会坍缩掉路径段（RJ/../../../../../login/ 实际
// 抓的是 https://www.dlsite.com/LOGIN/.html），单次百分号编码能绕过
// toUpperCase() 走私小写路径段（%6c → %6C，服务端仍解码成 l），`&` 往
// product.json 塞垃圾参数，`#` 把后面的 locale 整段截进 fragment。挡在
// 字符层面比逐个转义每处拼接可靠。校验必须排在补完 RJ 前缀之后，两条
// 返回路径才都过得了这一关。
const DLSITE_CODE_PATTERN = /^(?:RJ|VJ|BJ)\d{1,12}$/

export const normalizeDlsiteCode = (input: string): string => {
  const trimmed = input.trim().toUpperCase()
  if (!trimmed) {
    throw new Error('DLSITE_CODE_EMPTY')
  }

  const code = SUPPORTED_PREFIXES.some((prefix) => trimmed.startsWith(prefix))
    ? trimmed
    : `RJ${trimmed}`

  if (!DLSITE_CODE_PATTERN.test(code)) {
    throw new Error('DLSITE_CODE_INVALID')
  }

  return code
}

export const detectSiteFromUrl = (url: string): DlsiteSite | undefined => {
  try {
    const parsed = new URL(url)
    if (parsed.hostname.includes('dlsite.com')) {
      if (parsed.pathname.includes('/appx/')) return 'appx'
      if (parsed.pathname.includes('/aix/')) return 'aix'
      if (parsed.pathname.includes('/ai/')) return 'ai'
      if (parsed.pathname.includes('/pro/')) return 'pro'
      if (parsed.pathname.includes('/girls/')) return 'girls'
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
    return ['maniax', 'ai', 'aix', 'appx', 'girls']
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
