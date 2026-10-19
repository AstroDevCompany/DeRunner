import { useEffect, useState } from 'react'
import { api } from '@/lib/ipc'
import { act, data, refreshSessions, useApp } from '@/lib/store'
import { Button, Dialog, Segmented, Toggle } from '@/ui'

type Dur = 'manual' | '1' | '5' | '10' | 'custom'

export function TrackDialog() {
  const targets = useApp((s) => s.trackTargets)
  const [name, setName] = useState('')
  const [dur, setDur] = useState<Dur>('5')
  const [custom, setCustom] = useState(15)
  const [children, setChildren] = useState(true)
  const [busy, setBusy] = useState(false)
  const close = () => useApp.setState({ trackTargets: null })

  useEffect(() => {
    if (targets) {
      setName('')
      setBusy(false)
    }
  }, [targets])

  const procs = (targets ?? []).map((pid) => data.procs.get(pid)).filter(Boolean)
  const minutes = dur === 'manual' ? null : dur === 'custom' ? Math.max(1, custom) : Number(dur)

  const start = async () => {
    if (!targets) return
    setBusy(true)
    const id = await act(
      () => api.startSession(procs.map((p) => ({ pid: p!.pid, start: p!.start })), children, minutes ? minutes * 60 : null, name.trim() || undefined),
      'Tracking started',
    )
    setBusy(false)
    if (id !== undefined) {
      refreshSessions()
      close()
    }
  }

  return (
    <Dialog open={!!targets} onClose={close} title="Start tracking session" width={480}
      footer={<><Button onClick={close}>Cancel</Button><Button variant="primary" onClick={start} disabled={busy || !procs.length}>Start tracking</Button></>}>
      <div className="space-y-4">
        <div>
          <div className="label mb-1.5">Tracking</div>
          <div className="flex flex-wrap gap-1.5">
            {procs.map((p) => <span key={p!.pid} className="chip !h-6">{p!.name} <span className="num opacity-60">{p!.pid}</span></span>)}
            {!procs.length && <span className="text-faint">The selected process is no longer running.</span>}
          </div>
        </div>
        <div>
          <div className="label mb-1.5">Session name (optional)</div>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={procs[0]?.name ?? 'Session'} />
        </div>
        <div>
          <div className="label mb-1.5">Duration</div>
          <Segmented<Dur> value={dur} onChange={setDur} label="Duration" options={[{ id: 'manual', label: 'Until I stop' }, { id: '1', label: '1 min' }, { id: '5', label: '5 min' }, { id: '10', label: '10 min' }, { id: 'custom', label: 'Custom' }]} />
          {dur === 'custom' && (
            <div className="mt-2 flex items-center gap-2"><input type="number" min={1} max={360} className="input !w-24" value={custom} onChange={(e) => setCustom(+e.target.value)} aria-label="Custom minutes" /><span className="text-dim">minutes (max 360)</span></div>
          )}
          <div className="mt-1.5 text-[12px] text-faint">{minutes ? `Stops automatically after ${minutes} min and generates a report.` : 'Runs until you stop it (6 h safety limit).'}</div>
        </div>
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="font-medium">Include child processes</div>
            <div className="text-[12px] text-faint">Combine the process and everything it spawns (helpers, workers).</div>
          </div>
          <Toggle checked={children} onChange={setChildren} label="Include child processes" />
        </div>
        <div className="rounded-lg bg-accent-soft px-3 py-2 text-[12px] text-dim">Records CPU, memory, disk, network, threads and events (spawns, exits, suspends, priority changes, anomalies) once a second.</div>
      </div>
    </Dialog>
  )
}
