import { expect, test } from 'claude-code/testing'

import { moved } from './motion'

const SRC = 'ab cd\n\nef'

test('motions step by character, word and line, and stop at the ends', () => {
  expect(moved(SRC, 0, 'right')).toBe(1)
  expect(moved(SRC, 0, 'left')).toBe(0)
  expect(moved(SRC, 0, 'word')).toBe(3)
  expect(moved(SRC, 4, 'back')).toBe(3)
  expect(moved(SRC, 4, 'back')).not.toBe(4)
  expect(moved(SRC, 1, 'tail')).toBe(4)
  expect(moved(SRC, 4, 'home')).toBe(0)
  expect(moved(SRC, 1, 'down')).toBe(6)
  expect(moved(SRC, 6, 'down')).toBe(7)
  expect(moved(SRC, 7, 'down')).toBe(7)
  expect(moved(SRC, 7, 'up')).toBe(6)
  expect(moved(SRC, 0, 'up')).toBe(0)
  expect(moved(SRC, 0, 'bottom')).toBe(SRC.length - 1)
})
