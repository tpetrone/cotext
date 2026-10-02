import { expect, test } from 'claude-code/testing'

import { enclosingSymbol } from './symbols'

test('names a method by its class in TypeScript', () => {
  const source = [
    'export class BookmarkSyncService {',
    '  private async sync(items: string[]): Promise<void> {',
    '    if (items.length === 0) {',
    '      return',
    '    }',
    '  }',
    '}',
    'export const helper = async (x: number) => x',
  ].join('\n')
  expect(enclosingSymbol(source, 4)).toBe('BookmarkSyncService.sync')
  expect(enclosingSymbol(source, 2)).toBe('BookmarkSyncService.sync')
  expect(enclosingSymbol(source, 1)).toBe('BookmarkSyncService')
  expect(enclosingSymbol(source, 8)).toBe('helper')
})

test('names Python defs and Rust impl methods', () => {
  const python = ['class Store:', '    def save(self, item):', '        self.items.append(item)'].join('\n')
  expect(enclosingSymbol(python, 3)).toBe('Store.save')

  const rust = ['impl Store {', '    pub fn save(&mut self) {', '        self.n += 1;', '    }', '}'].join('\n')
  expect(enclosingSymbol(rust, 3)).toBe('Store.save')
})

test('names a Go method by its receiver, and nothing at the top level', () => {
  const go = ['func (s *Store) Save() error {', '\treturn nil', '}', '', 'var x = 1'].join('\n')
  expect(enclosingSymbol(go, 2)).toBe('Store.Save')
  expect(enclosingSymbol(go, 5)).toBeUndefined()
})
