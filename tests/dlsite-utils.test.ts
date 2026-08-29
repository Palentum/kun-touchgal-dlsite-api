import { expect, test } from 'vitest'
import { DL_SUPPORTED_LOCALES } from '../src/dlsite/constants'
import {
  cleanDlsiteTitle,
  ensureLocaleUrl,
  getCandidateSites,
  normalizeDlsiteCode
} from '../src/dlsite/utils'

test('cleanDlsiteTitle removes decorative brackets', () => {
  expect(
    cleanDlsiteTitle('【限定】JKフェラチオ！ [全年齢] だぶるアニメ！')
  ).toBe('JKフェラチオ！ だぶるアニメ！')
})

test('getCandidateSites prioritises RJ then AI domains', () => {
  expect(getCandidateSites('RJ012345')).toEqual([
    'maniax',
    'ai',
    'aix',
    'appx',
    'girls'
  ])
  expect(getCandidateSites('VJ01002419')).toEqual(['pro'])
})

test('normalizeDlsiteCode uppercases and fills the RJ prefix', () => {
  expect(normalizeDlsiteCode('rj01527759')).toBe('RJ01527759')
  expect(normalizeDlsiteCode(' 01527759 ')).toBe('RJ01527759')
  expect(normalizeDlsiteCode('VJ01002419')).toBe('VJ01002419')
  // 下限取 1 而非真实码的 6 位：纯数字的下限不影响注入面，收紧是行为变更
  expect(normalizeDlsiteCode('RJ1')).toBe('RJ1')
})

// 这些一旦活到 buildProductUrl / product.json 的拼接点，new URL 就会把抓取
// 目标改写成 dlsite.com 上的任意路径，或者往 query 里塞参数。
const INVALID_CODES = [
  'RJ/../../../../../login/',
  'RJ../../../login',
  'RJ/../../../../..//evil.com/x',
  'RJ\\..\\..\\evil.com',
  'RJ%6C%6F%67%69%6E',
  'RJ01527759&locale=en_US',
  'RJ01527759#',
  'RJ01527759?evil=1',
  'RJ',
  // 唯一一个不带前缀的向量，走的是补完 RJ 再校验那条路径 —— 钉住校验不能
  // 被挪到补前缀之前，否则这条会以 RJ../../../LOGIN 的形态漏过去
  '../../../login'
]

test.each(INVALID_CODES)('normalizeDlsiteCode rejects %j', (code) => {
  expect(() => normalizeDlsiteCode(code)).toThrow('DLSITE_CODE_INVALID')
})

test('normalizeDlsiteCode keeps the empty case on its own message', () => {
  expect(() => normalizeDlsiteCode('   ')).toThrow('DLSITE_CODE_EMPTY')
})

test('ensureLocaleUrl uses the correct product base per site', () => {
  const url = ensureLocaleUrl(
    undefined,
    DL_SUPPORTED_LOCALES.jp,
    'RJ01527759',
    'ai'
  )
  expect(url).toMatch(
    /^https:\/\/www\.dlsite\.com\/ai\/work\/=\/product_id\/RJ01527759/
  )
})
