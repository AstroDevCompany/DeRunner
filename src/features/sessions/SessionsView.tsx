import { useEffect, useMemo, useState } from 'react'
import { fmtAgo, fmtBytes, fmtClock, fmtDateTime, fmtDuration, fmtPct, fmtRel } from '@/lib/format'
import { useAsync } from '@/lib/hooks'
import { api, onEvent } from '@/lib/ipc'
import { act, confirmDialog, data, refreshSessions, toast, useApp } from '@/lib/store'
import type { Report, SessionMeta, Stats } from '@/lib/types'
import { Button, Chip, Empty, Icon, IconButton, Markdown, Spinner } from '@/ui'
import { Chart } from '../inspector/Chart'

const STATUS: Record<string, { label: string; kind?: 'ok' | 'warn' | 'crit' }> = {
  running: { label: 'Recording', kind: 'crit' }, completed: { label: 'Completed', kind: 'ok' }, stopped: { label: 'Stopped' }, exited: { label: 'Process exited', kind: 'warn' },
}

export function SessionsView() {
  const open = useApp((s) => s.openSessionId)
  const active = useApp((s) => s.activeSessions)
  const list = useAsync(() => api.sessions(), [])
  useEffect(() => {
    let off: (() => void)[] = []
    Promise.all([onEvent('sessions-changed', () => list.reload()), onEvent('session-report-updated', () => list.reload())]).then((o) => (off = o))
    return () => off.forEach((f) => f())
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const finished = (list.data ?? []).filter((s) => s.status !== 'running')
  return (
    <div className="flex min-h-0 flex-1 gap-2.5">
      <div className="flex w-[340px] flex-none flex-col gap-2.5 overflow-auto">
        {active.length > 0 && (
          <section className="space-y-2">
            <div className="label px-1">Recording now</div>
            {active.map((a) => <ActiveCard key={a.id} a={a} />)}
          </section>
        )}
        <section className="glass flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl">
          <div className="flex items-center justify-between px-4 pb-1 pt-3"><span className="label">History</span><span className="text-[11.5px] text-faint">{finished.length} sessions</span></div>
          <div className="min-h-0 flex-1 overflow-auto px-2 pb-2">
            {list.loading && !list.data ? <div className="p-4"><Spinner /></div> : finished.length === 0 ? (
              <Empty icon="record" title="No sessions yet">Select a process and press <b>Track</b> to record detailed telemetry and get a report.</Empty>
            ) : finished.map((s) => (
              <button key={s.id} className="trow !h-auto w-full !grid-cols-1 gap-0.5 !py-2 text-left" data-selected={open === s.id} onClick={() => useApp.setState({ openSessionId: s.id })}>
                <div className="flex items-center gap-2"><span className="truncate font-medium">{s.name}</span><Chip kind={STATUS[s.status]?.kind}>{STATUS[s.status]?.label ?? s.status}</Chip></div>
                <div className="num text-[11.5px] text-faint">{fmtDateTime(s.started_at)} · {fmtDuration(((s.ended_at ?? s.started_at) - s.started_at) / 1000)} · {s.targets.length} process{s.targets.length === 1 ? '' : 'es'}</div>
              </button>
            ))}
          </div>
        </section>
      </div>
      <div className="glass min-w-0 flex-1 overflow-auto rounded-2xl">
        {open ? <ReportPanel key={open} id={open} onDeleted={() => { useApp.setState({ openSessionId: null }); list.reload() }} /> : <Empty icon="layers" title="Pick a session">Reports summarise resource usage, notable events and anomalies. Add an AI provider in Settings for a written analysis.</Empty>}
      </div>
    </div>
  )
}

function ActiveCard({ a }: { a: import('@/lib/types').ActiveSession }) {
  useApp((s) => s.tick)
  const elapsed = (Date.now() - a.started_at) / 1000
  const total = a.ends_at ? (a.ends_at - a.started_at) / 1000 : null
  const root = data.live.get(a.targets[0]?.pid)
  return (
    <div className="glass rounded-2xl p-3.5">
      <div className="flex items-center gap-2">
        <span className="pulse h-2 w-2 rounded-full bg-crit" />
        <span className="flex-1 truncate font-semibold">{a.name}</span>
        <Button small variant="danger" onClick={() => act(() => api.stopSession(a.id)).then(refreshSessions)}><Icon name="stop" size={10} />Stop</Button>
      </div>
      <div className="mt-1 truncate text-[12px] text-faint">{a.targets.map((t) => t.name).join(', ')}{a.include_children ? ' + children' : ''}</div>
      <div className="num mt-2 flex items-center justify-between text-[12px]">
        <span>{fmtRel(elapsed * 1000)} elapsed</span>
        <span className="text-faint">{total ? `${fmtDuration(Math.max(0, total - elapsed))} left` : 'manual'}</span>
      </div>
      {total && <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-fg/10"><div className="h-full rounded-full bg-accent-2" style={{ width: `${Math.min(100, (elapsed / total) * 100)}%`, transition: 'width 1s linear' }} /></div>}
      {root && <div className="num mt-2 text-[12px] text-dim">CPU {fmtPct(root.cpu / Math.max(1, data.sys?.cores ?? 1))} · {fmtBytes(root.mem)}</div>}
    </div>
  )
}

const SEV_KIND = { info: undefined, warn: 'warn', critical: 'crit' } as const

function ReportPanel({ id, onDeleted }: { id: number; onDeleted: () => void }) {
  const d = useAsync(() => api.session(id), [id])
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let off: (() => void) | undefined
    onEvent<number>('session-report-updated', (sid) => sid === id && d.reload()).then((f) => (off = f))
    return () => off?.()
  }, [id]) // eslint-disable-line react-hooks/exhaustive-deps
  const det = d.data
  if (d.loading && !det) return <div className="p-6"><Spinner /></div>
  if (!det) return <Empty icon="alert" title="Could not load the session">{d.error}</Empty>
  const { meta, report } = det

  const genAi = async () => {
    setBusy(true)
    try { await api.sessionAiReport(id) } catch (e) { toast('error', e instanceof Error ? e.message : String(e)) }
    setBusy(false)
    d.reload()
  }
  const exportMd = async () => {
    const md = await act(() => api.sessionMarkdown(id))
    if (md) await act(() => api.exportText(`DeRunner-${meta.name.replace(/\W+/g, '-')}-${id}.md`, md), undefined).then((p) => p && toast('success', `Saved to ${p}`))
  }
  return (
    <div className="p-5">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[18px] font-semibold">{meta.name}</h2>
          <div className="num mt-0.5 text-[12px] text-faint">{fmtDateTime(meta.started_at)} · {fmtDuration(((meta.ended_at ?? Date.now()) - meta.started_at) / 1000)} · {fmtAgo(meta.ended_at ?? meta.started_at)}</div>
        </div>
        <Chip kind={STATUS[meta.status]?.kind}>{STATUS[meta.status]?.label}</Chip>
        <Button small onClick={exportMd}><Icon name="download" size={12} />Export .md</Button>
        <IconButton icon="trash" label="Delete session" onClick={async () => { if (await confirmDialog({ title: 'Delete this session?', body: 'The recorded telemetry and report will be permanently removed.', confirmLabel: 'Delete', danger: true })) { await act(() => api.deleteSession(id)); onDeleted() } }} />
      </div>
      {!report ? <div className="mt-6 text-faint">This session has no report (it was interrupted).</div> : (
        <>
          <section className="mt-5">
            <div className="label mb-2">Summary</div>
            <div className="space-y-1.5">
              {report.findings.map((f, i) => (
                <div key={i} className={`flex gap-2.5 rounded-xl px-3 py-2 text-[13px] ${f.severity === 'critical' ? 'bg-crit/10' : f.severity === 'warn' ? 'bg-warn/10' : 'bg-fg/5'}`}>
                  <Icon name={f.severity === 'info' ? 'info' : 'alert'} size={15} className={`mt-0.5 flex-none ${f.severity === 'critical' ? 'text-crit' : f.severity === 'warn' ? 'text-warn' : 'text-faint'}`} />
                  <span className="selectable">{f.text}</span>
                </div>
              ))}
            </div>
          </section>
          {report.targets.map((t) => <TargetSection key={t.pid} id={id} report={report} t={t} />)}
          <section className="mt-6">
            <div className="mb-2 flex items-center justify-between">
              <div className="label">AI analysis</div>
              <Button small onClick={genAi} disabled={busy}>{busy ? <Spinner size={12} /> : <Icon name="sparkles" size={12} />}{det.ai_report ? 'Regenerate' : 'Generate analysis'}</Button>
            </div>
            {det.ai_report ? (<><Markdown text={det.ai_report} /><div className="mt-2 text-[11.5px] text-faint">AI-generated from the report above; verify before acting. Anomalies are signals, not verdicts.</div></>)
              : det.ai_error ? <div className="rounded-xl bg-crit/10 px-3 py-2 text-[12.5px] text-crit">{det.ai_error}</div>
                : <div className="text-[12.5px] text-faint">Uses your default provider from Settings → AI. Only aggregate statistics from this report are sent, never raw samples.</div>}
          </section>
          <section className="mt-6">
            <div className="label mb-2">Events ({det.events.length})</div>
            <div className="max-h-72 overflow-auto rounded-xl border border-line">
              {det.events.map((e, i) => (
                <div key={i} className="flex items-baseline gap-3 border-b border-line px-3 py-1.5 text-[12.5px] last:border-0">
                  <span className="num w-14 flex-none text-faint">{fmtRel(e.t - meta.started_at)}</span>
                  <Chip kind={e.severity === 'critical' ? 'crit' : e.severity === 'warn' ? 'warn' : undefined}>{e.kind}</Chip>
                  <span className="selectable min-w-0 flex-1">{e.message}</span>
                  <span className="num text-[11px] text-faint">{fmtClock(e.t)}</span>
                </div>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  )
}

function StatRow({ label, s, fmt }: { label: string; s: Stats; fmt: (n: number) => string }) {
  return (
    <tr className="border-t border-line">
      <td className="py-1.5 pr-3 text-dim">{label}</td>
      {[s.min, s.avg, s.p95, s.max].map((v, i) => <td key={i} className="num py-1.5 pr-3 text-right">{fmt(v)}</td>)}
    </tr>
  )
}

function TargetSection({ id, report, t }: { id: number; report: Report; t: Report['targets'][number] }) {
  const series = useAsync(() => api.sessionSeries(id, t.pid), [id, t.pid])
  const rows = series.data ?? []
  const ts = useMemo(() => rows.map((r) => r.t / 1000), [rows])
  const cpu = useMemo(() => rows.map((r) => r.cpu / Math.max(1, report.ncpu)), [rows, report.ncpu])
  const mem = useMemo(() => rows.map((r) => r.mem / 1048576), [rows])
  return (
    <section className="mt-6">
      <div className="mb-2 flex items-center gap-2"><span className="label">{t.name}</span><span className="num text-[11.5px] text-faint">pid {t.pid} · {t.samples} samples{t.exited ? ' · exited' : ''}</span></div>
      <div className="grid grid-cols-2 gap-3">
        <div className="glass-flat rounded-xl p-3"><div className="mb-1 text-[12px] font-semibold text-dim">CPU (% of machine)</div>{rows.length > 1 ? <Chart t={ts} series={[{ label: 'CPU', color: 'var(--lvl-normal)', values: cpu }]} unit={(v) => `${Math.round(v)}%`} yMax={100} height={110} bands={[{ value: 70, color: 'var(--lvl-warn)' }, { value: 90, color: 'var(--lvl-crit)' }]} /> : <div className="py-8 text-center text-faint">No samples</div>}</div>
        <div className="glass-flat rounded-xl p-3"><div className="mb-1 text-[12px] font-semibold text-dim">Memory</div>{rows.length > 1 ? <Chart t={ts} series={[{ label: 'Memory', color: 'var(--accent-2)', values: mem }]} unit={(v) => (v >= 1024 ? `${(v / 1024).toFixed(1)}G` : `${Math.round(v)}M`)} height={110} /> : <div className="py-8 text-center text-faint">No samples</div>}</div>
      </div>
      <table className="mt-3 w-full text-[12.5px]">
        <thead><tr className="text-[11px] uppercase tracking-wide text-faint"><th className="text-left font-semibold">Metric</th><th className="text-right font-semibold">Min</th><th className="text-right font-semibold">Avg</th><th className="text-right font-semibold">p95</th><th className="text-right font-semibold">Max</th></tr></thead>
        <tbody>
          <StatRow label="CPU" s={t.cpu} fmt={(n) => fmtPct(n)} />
          <StatRow label="Memory" s={t.mem_mb} fmt={(n) => fmtBytes(n * 1048576)} />
          <StatRow label="Disk read" s={t.disk_read} fmt={(n) => `${n.toFixed(1)} MB/s`} />
          <StatRow label="Disk write" s={t.disk_write} fmt={(n) => `${n.toFixed(1)} MB/s`} />
          <StatRow label="Net in" s={t.net_rx} fmt={(n) => `${n.toFixed(0)} KB/s`} />
          <StatRow label="Net out" s={t.net_tx} fmt={(n) => `${n.toFixed(0)} KB/s`} />
        </tbody>
      </table>
      <ul className="mt-3 space-y-1 text-[12.5px] text-dim">{t.findings.map((f, i) => <li key={i} className="flex gap-2"><Chip kind={SEV_KIND[f.severity]}>{f.severity}</Chip><span className="selectable">{f.text}</span></li>)}</ul>
    </section>
  )
}

export type { SessionMeta }
