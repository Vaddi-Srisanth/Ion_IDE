import assert from 'node:assert/strict'
import { test } from 'node:test'
import { constrainMenuPosition, menuBoundaryIndex, moveMenuFocus, type ContextMenuItem } from '../src/renderer/context-menu-model'

const items: ContextMenuItem[] = [
  { type: 'item', id: 'open', label: 'Open' },
  { type: 'item', id: 'disabled', label: 'Disabled', disabled: true },
  { type: 'separator', id: 'divider' },
  { type: 'item', id: 'delete', label: 'Delete', danger: true },
]

test('menu navigation wraps and skips separators and disabled actions', () => {
  assert.equal(moveMenuFocus(items, -1, 1), 0)
  assert.equal(moveMenuFocus(items, 0, 1), 3)
  assert.equal(moveMenuFocus(items, 3, 1), 0)
  assert.equal(moveMenuFocus(items, 0, -1), 3)
  assert.equal(moveMenuFocus(items, -1, -1), 3)
})

test('menu boundaries select only enabled actions', () => {
  assert.equal(menuBoundaryIndex(items, 'first'), 0)
  assert.equal(menuBoundaryIndex(items, 'last'), 3)
  assert.equal(menuBoundaryIndex([{ type: 'separator', id: 'only' }], 'first'), -1)
  assert.equal(moveMenuFocus([{ type: 'item', id: 'off', label: 'Off', disabled: true }], 0, 1), -1)
})

test('menu placement remains within the viewport near every edge', () => {
  assert.deepEqual(constrainMenuPosition({ x: 200, y: 150 }, { width: 120, height: 80 }, { width: 800, height: 600 }),
    { x: 200, y: 150 })
  assert.deepEqual(constrainMenuPosition({ x: 790, y: 590 }, { width: 180, height: 140 }, { width: 800, height: 600 }),
    { x: 614, y: 454 })
  assert.deepEqual(constrainMenuPosition({ x: -20, y: -30 }, { width: 180, height: 140 }, { width: 800, height: 600 }),
    { x: 6, y: 6 })
})

test('placement stays stable when the menu is larger than the viewport', () => {
  assert.deepEqual(constrainMenuPosition({ x: 90, y: 90 }, { width: 500, height: 500 }, { width: 100, height: 100 }),
    { x: 6, y: 6 })
})
