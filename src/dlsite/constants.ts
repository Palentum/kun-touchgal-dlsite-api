import type { DlsiteSite } from './types'

export const DLSITE_PRODUCT_BASE: Record<DlsiteSite, string> = {
  maniax: 'https://www.dlsite.com/maniax/work/=/product_id',
  ai: 'https://www.dlsite.com/ai/work/=/product_id',
  aix: 'https://www.dlsite.com/aix/work/=/product_id',
  appx: 'https://www.dlsite.com/appx/work/=/product_id',
  pro: 'https://www.dlsite.com/pro/work/=/product_id'
}

export const DLSITE_HOST = 'https://www.dlsite.com'

export const REQUEST_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8,ja;q=0.7'
}

export const ADULT_COOKIE = 'adult_checked=1'

export const SUPPORTED_PREFIXES = ['RJ', 'VJ', 'BJ']

export const DL_SUPPORTED_LOCALES = {
  cn: 'zh_CN',
  jp: 'ja_JP',
  en: 'en_US'
} as const
