export interface DlsiteApiResponse {
  rj_code: string
  title_default: string
  title_jp?: string
  title_en?: string
  release_date?: string
  tags?: string
  circle_name?: string
  circle_link?: string
}

export interface CircleInfo {
  name: string
  link?: string
}

export interface DlsiteEditionLinks {
  jp?: string | null
  en?: string | null
}

export type DlsiteLocale = 'zh_CN' | 'ja_JP' | 'en_US'

export type DlsiteSite = 'maniax' | 'ai' | 'aix' | 'appx' | 'pro'
