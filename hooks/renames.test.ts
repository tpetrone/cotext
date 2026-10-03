import { expect, test } from 'claude-code/testing'

import { followRename, parseRenames } from './renames'

test('reads renames out of name-status output and skips the rest', () => {
  const output = [
    ...['M', 'a.md'],
    ...['R075', 'skills/expand/SKILL.md', 'skills/expandir/SKILL.md'],
    ...['C100', 'x', 'y'],
    ...['D', 'z', ''],
  ].join('\0')
  expect(parseRenames(output)).toEqual([['skills/expand/SKILL.md', 'skills/expandir/SKILL.md']])
})

test('follows a chain of renames and stops on a cycle', () => {
  expect(followRename(new Map([['a', 'b'], ['b', 'c']]), 'a')).toBe('c')
  expect(followRename(new Map([['a', 'b'], ['b', 'a']]), 'a')).toBe('a')
  expect(followRename(new Map(), 'a')).toBe('a')
})
