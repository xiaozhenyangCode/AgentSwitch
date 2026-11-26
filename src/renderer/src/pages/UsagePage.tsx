import { useEffect } from 'react'
import { useApp } from '../state/AppContext'
import { t } from '../state/i18n'
import { RefreshUsage, UsageView } from '../components/Usage'
import { DialogHeader } from '../components/PageDialog'
import { refreshUsage } from '../state/usage'

let lastAutoRefresh = 0
const AUTO_REFRESH_MS = 45_000

/** 用量限额: overview, per-account quota windows and a per-account usage table. */
export function UsagePage({ onClose }: { onClose: () => void }) {
  const { loaded } = useApp()
  useEffect(() => {
    if (!loaded) return
    const now = Date.now()
    if (now - lastAutoRefresh < AUTO_REFRESH_MS) return
    lastAutoRefresh = now
    void refreshUsage()
  }, [loaded])
  return (
    <>
      <DialogHeader title={t('usage.title')} desc={t('usage.desc')} actions={<RefreshUsage />} onClose={onClose} />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{loaded && <UsageView onClose={onClose} />}</div>
    </>
  )
}
