import { useCallback } from 'react'
import { useApp } from './AppContext'
import { activeThread, newThread, useChat } from './chat'
import { isReady } from '../lib/ui'

/** Starts a new thread: all ready accounts participate; driver carries over from the current thread. */
export function useStartThread() {
  const { profiles, navigate } = useApp()
  const chat = useChat()
  return useCallback(
    (projectDir: string | null) => {
      const ready = profiles.filter(isReady)
      const prev = activeThread(chat)?.driver
      const keep = prev?.profileId && profiles.some((p) => p.id === prev.profileId)
      newThread({
        projectDir,
        participants: ready.map((p) => p.id),
        driver: keep ? prev! : { profileId: ready[0]?.id ?? profiles[0]?.id ?? null, model: null }
      })
      navigate('workbench')
    },
    [profiles, chat, navigate]
  )
}
