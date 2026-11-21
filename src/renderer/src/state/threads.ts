import { useCallback } from 'react'
import { useApp } from './AppContext'
import { activeThread, newThread, useChat } from './chat'
import { getSettings } from './settings'
import { isReady } from '../lib/ui'

/**
 * Starts a new thread: all ready accounts participate. Driver: 设置 › 新对话默认账号 when set,
 * else it carries over from the current thread.
 */
export function useStartThread() {
  const { profiles, navigate } = useApp()
  const chat = useChat()
  return useCallback(
    (projectDir: string | null) => {
      const ready = profiles.filter(isReady)
      const exists = (id: string | null | undefined) => !!id && profiles.some((p) => p.id === id)
      const pref = getSettings().defaultDriver
      const prev = activeThread(chat)?.driver
      newThread({
        projectDir,
        participants: ready.map((p) => p.id),
        driver: exists(pref) ? { profileId: pref, model: null } : exists(prev?.profileId) ? prev! : { profileId: ready[0]?.id ?? profiles[0]?.id ?? null, model: null }
      })
      navigate('workbench')
    },
    [profiles, chat, navigate]
  )
}
