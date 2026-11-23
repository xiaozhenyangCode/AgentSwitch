import type { ModelOption } from '@shared/types'
import { effortLabel } from '../lib/models'
import { Segmented } from './common'
import { t } from '../state/i18n'
import { stripLatest } from '@shared/i18n'

/** Effort (thinking strength) segmented control; hidden when the model has < 2 levels. */
export function EffortBar({ opt, effort, onChange, reasonix }: { opt: ModelOption | null; effort: string | null; reasonix?: boolean; onChange: (e: string | null) => void }) {
  if (!opt?.efforts || opt.efforts.length < 2) return null
  return (
    <div className="px-2 pb-2">
      <div className="mb-1 flex items-center px-0.5 text-[11px] text-ink-3">
        <span>{t('effort.title', { model: stripLatest(opt.label) })}</span>
        {opt.defaultEffort && <span className="ml-auto">{t('effort.default', { e: effortLabel(opt.defaultEffort, reasonix) })}</span>}
      </div>
      <Segmented
        size="sm"
        value={effort && opt.efforts.includes(effort) ? effort : ''}
        onChange={(v) => onChange(v || null)}
        options={[{ value: '', label: t('common.default') }, ...opt.efforts.map((e) => ({ value: e, label: effortLabel(e, reasonix), title: e }))]}
      />
    </div>
  )
}
