import { useApp } from '../state/AppContext'
import { t } from '../state/i18n'
import { RefreshUsage, UsageView } from '../components/Usage'

/** 用量限额: overview, per-account quota windows and a per-account usage table. */
export function UsagePage() {
  const { loaded } = useApp()
  return (
    <div className="h-full overflow-y-auto">
      <div className="drag h-14" />
      <div className="mx-auto max-w-4xl px-10 pb-16">
        <div className="flex items-center gap-4">
          <h1 className="flex-1 text-[26px] leading-tight font-semibold tracking-tight text-ink">{t('usage.title')}</h1>
          <div className="no-drag">
            <RefreshUsage />
          </div>
        </div>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-3">{t('usage.desc')}</p>
        {loaded && (
          <div className="mt-7">
            <UsageView />
          </div>
        )}
      </div>
    </div>
  )
}
