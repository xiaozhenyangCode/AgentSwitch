import type { ModelOption } from '@shared/types'
import { EFFORT_LABEL } from '@shared/modelSpec'
import { Segmented } from './common'

/** Effort (thinking strength) segmented control; hidden when the model has < 2 levels. */
export function EffortBar({ opt, effort, onChange }: { opt: ModelOption | null; effort: string | null; onChange: (e: string | null) => void }) {
  if (!opt?.efforts || opt.efforts.length < 2) return null
  return (
    <div className="px-2 pb-2">
      <div className="mb-1 flex items-center px-0.5 text-[11px] text-ink-3">
        <span>思考强度 · {opt.label.replace(/（最新）$/, '')}</span>
        {opt.defaultEffort && <span className="ml-auto">默认 = {EFFORT_LABEL[opt.defaultEffort] ?? opt.defaultEffort}</span>}
      </div>
      <Segmented
        size="sm"
        value={effort && opt.efforts.includes(effort) ? effort : ''}
        onChange={(v) => onChange(v || null)}
        options={[{ value: '', label: '默认' }, ...opt.efforts.map((e) => ({ value: e, label: EFFORT_LABEL[e] ?? e, title: e }))]}
      />
    </div>
  )
}
