import { useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { constrainMenuPosition, isEnabledMenuAction, menuBoundaryIndex, moveMenuFocus,
  type ContextMenuAction, type ContextMenuItem, type ContextMenuPosition } from './context-menu-model'
import './context-menu.css'

export type { ContextMenuAction, ContextMenuItem, ContextMenuPosition, ContextMenuSeparator } from './context-menu-model'

export function ContextMenu({ open, position, items, onSelect, onClose, ariaLabel = 'Context menu' }: {
  open: boolean
  position: ContextMenuPosition
  items: readonly ContextMenuItem[]
  onSelect(item: ContextMenuAction): void
  onClose(): void
  ariaLabel?: string
}) {
  const menuRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef(new Map<number, HTMLButtonElement>())
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const [activeIndex, setActiveIndex] = useState(-1)
  const [resolvedPosition, setResolvedPosition] = useState(position)

  const placeWithinViewport = useCallback(() => {
    const menu = menuRef.current
    if (!menu) return
    const bounds = menu.getBoundingClientRect()
    setResolvedPosition(constrainMenuPosition(position, { width: bounds.width, height: bounds.height },
      { width: window.innerWidth, height: window.innerHeight }))
  }, [position])

  useLayoutEffect(() => {
    if (!open) return
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    return () => {
      const restoreTarget = restoreFocusRef.current
      restoreFocusRef.current = null
      if (restoreTarget?.isConnected) restoreTarget.focus()
    }
  }, [open])

  useLayoutEffect(() => {
    if (!open) return
    setActiveIndex((current) => isEnabledMenuAction(items[current]) ? current : menuBoundaryIndex(items, 'first'))
  }, [items, open])

  useLayoutEffect(() => {
    if (!open) return
    setResolvedPosition(position)
    placeWithinViewport()
  }, [items, open, placeWithinViewport, position])

  useLayoutEffect(() => {
    if (!open) return
    const onOutsidePointer = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onCloseRef.current()
    }
    document.addEventListener('pointerdown', onOutsidePointer, true)
    window.addEventListener('resize', placeWithinViewport)
    return () => {
      document.removeEventListener('pointerdown', onOutsidePointer, true)
      window.removeEventListener('resize', placeWithinViewport)
    }
  }, [open, placeWithinViewport])

  useLayoutEffect(() => {
    if (!open) return
    if (activeIndex >= 0) itemRefs.current.get(activeIndex)?.focus()
    else menuRef.current?.focus()
  }, [activeIndex, open])

  if (!open) return null

  const select = (item: ContextMenuAction) => {
    if (item.disabled) return
    onSelect(item)
    onClose()
  }
  const focusAt = (index: number) => {
    if (index >= 0) setActiveIndex(index)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    let nextIndex = -1
    if (event.key === 'ArrowDown') nextIndex = moveMenuFocus(items, activeIndex, 1)
    else if (event.key === 'ArrowUp') nextIndex = moveMenuFocus(items, activeIndex, -1)
    else if (event.key === 'Home') nextIndex = menuBoundaryIndex(items, 'first')
    else if (event.key === 'End') nextIndex = menuBoundaryIndex(items, 'last')
    else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onClose()
      return
    } else if (event.key === 'Enter' || event.key === ' ') {
      const item = items[activeIndex]
      if (isEnabledMenuAction(item)) {
        event.preventDefault()
        event.stopPropagation()
        select(item)
      }
      return
    } else return
    event.preventDefault()
    event.stopPropagation()
    focusAt(nextIndex)
  }

  const target = document.querySelector<HTMLElement>('.app-shell') ?? document.body
  return createPortal(<div className="context-menu" role="menu" aria-label={ariaLabel} tabIndex={-1} ref={menuRef}
    style={{ left: resolvedPosition.x, top: resolvedPosition.y }} onKeyDown={onKeyDown}
    onContextMenu={(event) => event.preventDefault()}>
    {items.map((item, index) => item.type === 'separator'
      ? <div className="context-menu-separator" role="separator" key={item.id}/>
      : <button type="button" role="menuitem" className={`context-menu-item${item.danger ? ' danger' : ''}`}
          aria-disabled={item.disabled || undefined} disabled={item.disabled} tabIndex={index === activeIndex ? 0 : -1}
          key={item.id} ref={(element) => { if (element) itemRefs.current.set(index, element); else itemRefs.current.delete(index) }}
          onPointerMove={() => { if (!item.disabled) setActiveIndex(index) }} onClick={() => select(item)}>
          {item.label}
        </button>)}
  </div>, target)
}
