import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseHTML } from 'linkedom'
import { expect, test } from 'vitest'
import { extractEditionLinks } from '../src/dlsite/parsers'

const readMetaDoc = (filename: string): Document =>
  parseHTML(readFileSync(resolve(process.cwd(), 'meta', filename), 'utf8'))
    .document

test('extractEditionLinks ignores the same-series product list', () => {
  // type_body anchors read "ASMR版 1,485 JPY 1,980 JPY" and point at RJ01527748,
  // a *different* work. Matching "JPY" as Japanese pulled its title into title_jp.
  expect(extractEditionLinks(readMetaDoc('RJ01527759_RJ.html'))).toEqual({})
})

test('extractEditionLinks reads the type_trans language list', () => {
  expect(extractEditionLinks(readMetaDoc('VJ01002419_VJ.html'))).toEqual({
    jp: 'https://www.dlsite.com/pro/work/=/product_id/VJ01002419.html'
  })
})
