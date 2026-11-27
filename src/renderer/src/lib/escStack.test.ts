import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let listeners: ((e: any) => void)[] = []
let mod: typeof import('./escStack')

beforeEach(async () => {
  vi.resetModules()
  listeners = []
  vi.stubGlobal('window', {
    addEventListener: (_type: string, fn: (e: any) => void) => listeners.push(fn)
  })
  mod = await import('./escStack')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('escStack / ⌘W topmost layer handling', () => {
  it('returns false on ⌘W when no dialog is open so the window closes normally', () => {
    expect(mod.escLayers()).toBe(0)
    expect(mod.closeTopLayer()).toBe(false)
    expect((window as unknown as { __agentswitchCloseTop?: () => boolean }).__agentswitchCloseTop?.()).toBe(false)
  })

  it('closes nested dialogs one by one from topmost downward on ⌘W', () => {
    const outerClose = vi.fn()
    const innerClose = vi.fn()
    const popOuter = mod.pushLayer({ onEsc: outerClose, onClose: outerClose })
    const popInner = mod.pushLayer({ onEsc: innerClose, onClose: innerClose })

    expect(mod.closeTopLayer()).toBe(true)
    expect(innerClose).toHaveBeenCalledTimes(1)
    expect(outerClose).not.toHaveBeenCalled()

    popInner()
    expect(mod.closeTopLayer()).toBe(true)
    expect(outerClose).toHaveBeenCalledTimes(1)

    popOuter()
    expect(mod.closeTopLayer()).toBe(false)
  })

  it('supports distinct Esc (clear search) vs ⌘W (close directly) and blocks Esc leaks under non-Esc modals', () => {
    const clearSearch = vi.fn()
    const closeSettings = vi.fn()
    const popSettings = mod.pushLayer({ onEsc: clearSearch, onClose: closeSettings })

    // Esc clears search; ⌘W closes Settings immediately
    const escEvent = { key: 'Escape', isComposing: false, target: null, preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() }
    listeners[0](escEvent)
    expect(clearSearch).toHaveBeenCalledTimes(1)
    expect(closeSettings).not.toHaveBeenCalled()

    expect(mod.closeTopLayer()).toBe(true)
    expect(closeSettings).toHaveBeenCalledTimes(1)

    // Top modal with no Esc action (e.g. LoginModal / pending undo) blocks Esc from leaking to lower dialog
    const cancelLogin = vi.fn()
    const popLogin = mod.pushLayer({ onEsc: () => {}, onClose: cancelLogin })
    listeners[0](escEvent)
    expect(clearSearch).toHaveBeenCalledTimes(1)

    expect(mod.closeTopLayer()).toBe(true)
    expect(cancelLogin).toHaveBeenCalledTimes(1)

    popLogin()
    popSettings()
  })

  it('invokes focus-scoped ⌘W handler only when no modal layer is open', () => {
    let focused = false
    const closeTab = vi.fn(() => {
      if (!focused) return false
      return true
    })
    const popFocus = mod.pushFocusCloseHandler(closeTab)

    // Focus outside editor -> returns false so window closes normally
    expect(mod.closeTopLayer()).toBe(false)
    expect(closeTab).toHaveBeenCalledTimes(1)

    // Focus inside editor -> consumes ⌘W to close tab instead of window
    focused = true
    expect(mod.closeTopLayer()).toBe(true)
    expect(closeTab).toHaveBeenCalledTimes(2)

    // When a modal is open, the modal takes priority over the focus handler
    const closeModal = vi.fn()
    const popModal = mod.pushLayer({ onEsc: closeModal, onClose: closeModal })
    expect(mod.closeTopLayer()).toBe(true)
    expect(closeModal).toHaveBeenCalledTimes(1)
    expect(closeTab).toHaveBeenCalledTimes(2)

    popModal()
    popFocus()
  })
})
