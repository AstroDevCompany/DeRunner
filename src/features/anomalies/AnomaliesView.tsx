import { useMemo, useState } from 'react'
import { askAi, inspect, trackProcs } from '@/lib/actions'
import { fmtAgo } from '@/lib/format'
import { api } from '@/lib/ipc'
import { act, data, updateSettings, useApp } from '@/lib/store'
import type { Anomaly } from '@/lib/types'
import { Button, Chip, Empty, Icon, Segmented } from '@/ui'

const KIND_LABEL: Record<string, string> = {
  cpu_critical: 'Sustained CPU', cpu_warn: 'Sustained CPU', mem_critical: 'Memory share', mem_warn: 'Memory share', cpu_spike: 'CPU spike', mem_growth: 'Memory growth',
  thread_surge: 'Thread surge', net_burst: 'Network burst', zombie: 'Zombie', child_storm: 'Process burst', odd_location: 'Unusual location',
}

export function AnomaliesView() {
  const all = useApp((s) => s.anomalies)
  const settings = useApp((s) => s.settings)
  const [filter, setFilter] = useState<'active' | 'all'>('active')
  const list = useMemo(() => all.filter((a) => filter === 'all' || !a.dismissed), [all, filter])
  const dismiss = (id: number | null) => {
    api.dismissAnomaly(id)
    useApp.setState((s) => ({ anomalies: s.anomalies.map((a) => (id == null || a.id === id ? { ...a, dismissed: true } : a)) }))
  }
  const allow = (a: Anomaly) => {
    updateSettings((s) => ({ ...s, anomaly: { ...s.anomaly, allowlist: [...new Set([...s.anomaly.allowlist, a.name])] } }))
    dismiss(a.id)
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-2.5 flex items-center gap-3">
        <Segmented<'active' | 'all'> value={filter} onChange={setFilter} label="Filter" options={[{ id: 'active', label: 'Active' }, { id: 'all', label: 'All' }]} />
        <p className="flex-1 text-[12px] text-faint">Signals worth a look: sustained load, spikes, leak-like growth and unusual behaviour. They are heuristics, <b>not</b> verdicts and never mean "malware" by themselves.</p>
        <Button small onClick={() => dismiss(null)} disabled={!list.some((a) => !a.dismissed)}>Dismiss all</Button>
      </div>
      {settings && !settings.anomaly.enabled && <div className="mb-2.5 rounded-xl bg-warn/10 px-3 py-2 text-[12.5px] text-warn">Anomaly detection is turned off in Settings → Monitoring.</div>}
      <div className="glass min-h-0 flex-1 overflow-auto rounded-2xl p-2">
        {list.length === 0 ? <Empty icon="shield" title="All quiet">Nothing unusual has been detected. DeRunner keeps watching in the background.</Empty> : list.map((a) => {
          const alive = data.procs.has(a.pid)
          return (
            <div key={a.id} className={`rounded-xl border-b border-line px-3.5 py-3 last:border-0 ${a.dismissed ? 'opacity-50' : ''}`}>
              <div className="flex items-start gap-3">
                <span className={`mt-0.5 grid h-7 w-7 flex-none place-items-center rounded-lg ${a.severity === 'critical' ? 'bg-crit/15 text-crit' : a.severity === 'warn' ? 'bg-warn/15 text-warn' : 'bg-fg/8 text-dim'}`}><Icon name={a.severity === 'info' ? 'info' : 'alert'} size={16} /></span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="selectable font-semibold">{a.title}</span>
                    <Chip kind={a.severity === 'critical' ? 'crit' : a.severity === 'warn' ? 'warn' : undefined}>{KIND_LABEL[a.kind] ?? a.kind}</Chip>
                    <span className="text-[11.5px] text-faint">{fmtAgo(a.ts)} · pid {a.pid}</span>
                  </div>
                  <p className="selectable mt-1 text-[12.5px] text-dim">{a.detail}</p>
                  {a.threshold > 0 && <p className="num mt-1 text-[11.5px] text-faint">Observed {a.value.toFixed(a.value < 10 ? 1 : 0)} vs. threshold {a.threshold.toFixed(0)} ({a.metric})</p>}
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <Button small onClick={() => inspect(a.pid)} disabled={!alive}>Inspect</Button>
                    <Button small onClick={() => trackProcs([a.pid])} disabled={!alive}><Icon name="record" size={11} />Track</Button>
                    <Button small onClick={() => askAi(a.pid)}><Icon name="sparkles" size={11} />Investigate with AI</Button>
                    {!a.dismissed && <Button small onClick={() => dismiss(a.id)}>Dismiss</Button>}
                    {!a.dismissed && <Button small onClick={() => act(async () => allow(a), `${a.name} won't be flagged again`)} title="Never flag this process name again">Always ignore {a.name}</Button>}
                  </div>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
