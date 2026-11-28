import { useLayoutEffect, useRef } from 'react'
import { t } from '../state/i18n'

export function EditorResizeHandle({ edge, size, onResize, onReset }: {
  edge: 'left' | 'right' | 'top'
  size: number
  onResize: (size: number) => void
  onReset: () => void
}) {
  const finishDrag = useRef<(() => void) | null>(null)
  const resize = useRef(onResize)
  resize.current = onResize
  const vertical = edge === 'top'
  const cursor = vertical ? 'row-resize' : 'col-resize'
  const edgeClass = {
    left: 'inset-y-0 -left-1 w-2 cursor-col-resize',
    right: 'inset-y-0 -right-1 w-2 cursor-col-resize',
    top: 'inset-x-0 -top-1 h-2 cursor-row-resize'
  }[edge]

  useLayoutEffect(() => () => finishDrag.current?.(), [edge])

  return (
    <div
      role="separator"
      aria-orientation={vertical ? 'horizontal' : 'vertical'}
      aria-label={t('chg.resize')}
      title={t('chg.resize')}
      className={`no-drag absolute z-20 touch-none transition-colors hover:bg-accent/25 ${edgeClass}`}
      onPointerDown={(event) => {
        if (event.button !== 0 || finishDrag.current) return
        event.preventDefault()
        const { currentTarget: handle, pointerId } = event
        const start = vertical ? event.clientY : event.clientX
        const body = document.body.style
        const previousCursor = body.cursor
        const previousUserSelect = body.userSelect
        body.cursor = cursor
        body.userSelect = 'none'

        const move = (pointer: PointerEvent) => {
          if (pointer.pointerId !== pointerId || !(pointer.buttons & 1)) return
          const delta = (vertical ? pointer.clientY : pointer.clientX) - start
          resize.current(size + (edge === 'right' ? delta : -delta))
        }
        const finish = () => {
          finishDrag.current = null
          window.removeEventListener('pointermove', move, true)
          window.removeEventListener('pointerup', stop, true)
          window.removeEventListener('pointercancel', stop, true)
          window.removeEventListener('blur', finish)
          handle.removeEventListener('lostpointercapture', stop)
          if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId)
          body.cursor = previousCursor
          body.userSelect = previousUserSelect
        }
        const stop = (pointer: PointerEvent) => {
          if (pointer.pointerId === pointerId) finish()
        }

        finishDrag.current = finish
        handle.setPointerCapture(pointerId)
        window.addEventListener('pointermove', move, true)
        window.addEventListener('pointerup', stop, true)
        window.addEventListener('pointercancel', stop, true)
        window.addEventListener('blur', finish)
        handle.addEventListener('lostpointercapture', stop)
      }}
      onDoubleClick={onReset}
    />
  )
}
