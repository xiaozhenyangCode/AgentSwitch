import { useApp } from '../state/AppContext'
import { t } from '../state/i18n'
import { RefreshUsage, UsageView } from '../components/Usage'
import { DialogHeader } from '../components/PageDialog'

/** 用量限额: overview, per-account quota windows and a per-account usage table. */
export function UsagePage({ onClose }: { onClose: () => void }) {
  const { loaded } = useApp()
  return (
    <>
      <DialogHeader title={t('usage.title')} desc={t('usage.desc')} actions={<RefreshUsage />} onClose={onClose} />
      <div className="min-h-0 flex-1 overflow-y-auto px-8 pt-6 pb-10">{loaded && <UsageView />}</div>
    </>
  )
}
