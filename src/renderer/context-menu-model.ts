export type ContextMenuAction = {
  type: 'item'
  id: string
  label: string
  disabled?: boolean
  danger?: boolean
}

export type ContextMenuSeparator = {
  type: 'separator'
  id: string
}

export type ContextMenuItem = ContextMenuAction | ContextMenuSeparator

export type ContextMenuPosition = Readonly<{ x: number; y: number }>

export function isEnabledMenuAction(item: ContextMenuItem | undefined): item is ContextMenuAction {
  return item?.type === 'item' && item.disabled !== true
}

export function menuBoundaryIndex(items: readonly ContextMenuItem[], edge: 'first' | 'last'): number {
  if (edge === 'first') return items.findIndex(isEnabledMenuAction)
  return items.findLastIndex(isEnabledMenuAction)
}

export function moveMenuFocus(items: readonly ContextMenuItem[], currentIndex: number, direction: 1 | -1): number {
  if (!items.length) return -1
  const fallback = direction === 1 ? -1 : 0
  const start = currentIndex >= 0 && currentIndex < items.length ? currentIndex : fallback
  for (let offset = 1; offset <= items.length; offset += 1) {
    const candidate = (start + direction * offset + items.length * 2) % items.length
    if (isEnabledMenuAction(items[candidate])) return candidate
  }
  return -1
}

export function constrainMenuPosition(position: ContextMenuPosition, menu: Readonly<{ width: number; height: number }>,
  viewport: Readonly<{ width: number; height: number }>, margin = 6): ContextMenuPosition {
  const safeMargin = Math.max(0, margin)
  const maximumX = Math.max(safeMargin, viewport.width - Math.max(0, menu.width) - safeMargin)
  const maximumY = Math.max(safeMargin, viewport.height - Math.max(0, menu.height) - safeMargin)
  return {
    x: Math.min(Math.max(position.x, safeMargin), maximumX),
    y: Math.min(Math.max(position.y, safeMargin), maximumY),
  }
}
