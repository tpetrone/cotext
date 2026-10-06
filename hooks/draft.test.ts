import { expect, test } from 'claude-code/testing'

import type { Hunk } from '../types'
import {
  applyEdit,
  baseToDisplay,
  baseToWorking,
  diffHunks,
  display,
  displayToBase,
  displayToWorking,
  working,
} from './draft'

const BASE = 'O sistema usa SQLite como banco principal.'

let n = 0
const id = () => `h${++n}`

test('an edit is cut down to the words that changed', () => {
  n = 0
  const at = BASE.indexOf('SQLite como banco')
  const hunks = applyEdit(BASE, [], at, at + 'SQLite como banco'.length, 'Postgres como banco', ['t1'], id)
  expect(hunks).toEqual([{ id: 'h1', start: at, end: at + 6, text: 'Postgres', threads: ['t1'] }])
  expect(working(BASE, hunks)).toBe('O sistema usa Postgres como banco principal.')
  expect(display(BASE, hunks)).toEqual({
    text: 'O sistema usa SQLitePostgres como banco principal.',
    spans: [
      { kind: 'del', start: at, end: at + 6, hunk: 'h1' },
      { kind: 'ins', start: at + 6, end: at + 14, hunk: 'h1' },
    ],
  })
})

test('a rewrite of a sentence shows as several small changes', () => {
  const was = 'A API será REST e síncrona.'
  const now = 'A API será gRPC e assíncrona.'
  expect(diffHunks(was, now, 0).map(one => [was.slice(one.start, one.end), one.text])).toEqual([
    ['REST', 'gRPC'],
    ['síncrona', 'assíncrona'],
  ])
})

test('an edit over an earlier change folds it in, keeping both threads', () => {
  n = 0
  const first = applyEdit(BASE, [], 14, 20, 'Postgres', ['t1'], id)
  // The working text now reads "usa Postgres como"; replace "Postgres como banco" with "DuckDB".
  const work = working(BASE, first)
  const from = work.indexOf('Postgres')
  const second = applyEdit(BASE, first, from, from + 'Postgres como banco'.length, 'DuckDB', ['t2'], id)
  expect(working(BASE, second)).toBe('O sistema usa DuckDB principal.')
  expect(second).toHaveLength(1)
  expect(second[0]!.threads).toEqual(['t1', 't2'])
  // Undoing the fold is dropping the hunk: the base comes back.
  expect(working(BASE, second.filter(one => one.id !== second[0]!.id))).toBe(BASE)
})

test('an edit that restores the base leaves no change', () => {
  const first = applyEdit(BASE, [], 14, 20, 'Postgres')
  const from = working(BASE, first).indexOf('Postgres')
  expect(applyEdit(BASE, first, from, from + 8, 'SQLite')).toEqual([])
})

test('offsets map between the base, the display and the working text', () => {
  // "usa " deleted, " novo" inserted after "banco".
  const hunks: Hunk[] = [
    { id: 'a', start: 10, end: 14, text: '', threads: [] },
    { id: 'b', start: 31, end: 31, text: ' novo', threads: [] },
  ]
  expect(display(BASE, hunks).text).toBe(BASE.slice(0, 31) + ' novo' + BASE.slice(31))
  expect(working(BASE, hunks)).toBe('O sistema SQLite como banco novo principal.')

  // A range ending where a deletion starts leaves it out; one starting there takes it in.
  expect(baseToDisplay(hunks, 10, 'end')).toBe(10)
  expect(baseToDisplay(hunks, 10, 'start')).toBe(10)
  expect(baseToDisplay(hunks, 14, 'start')).toBe(14)
  // An insertion at an edge is inside the range on either side.
  expect(baseToDisplay(hunks, 31, 'start')).toBe(31)
  expect(baseToDisplay(hunks, 31, 'end')).toBe(36)

  // Inserted text has no base: it maps to its hunk's edge.
  expect(displayToBase(hunks, 33, 'start')).toBe(31)
  expect(displayToBase(hunks, 33, 'end')).toBe(31)
  expect(displayToBase(hunks, 40, 'start')).toBe(35)
  // Struck text is gone from the working text.
  expect(displayToWorking(hunks, 12)).toBe(10)
  expect(displayToWorking(hunks, 33)).toBe(29)
  expect(baseToWorking(hunks, 20, 'start')).toBe(16)
  expect(baseToWorking(hunks, 31, 'end')).toBe(32)
})
