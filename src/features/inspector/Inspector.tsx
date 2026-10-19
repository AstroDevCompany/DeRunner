import { useEffect, useMemo, useRef, useState } from 'react'
import { askAi, copyText, focusProc, inspect, isProtected, relaunchProc, resumeProc, setPriorityProc, suspendProc, terminateProc, trackProcs } from '@/lib/actions'
import { basename, fmtAgo, fmtBytes, fmtDateTime, fmtDuration, fmtPct, fmtRate } from '@/lib/format'
import { useAsync } from '@/lib/hooks'
import { api } from '@/lib/ipc'
import { cpuPct, diskPct, memPct, netPct, scaleFrom } from '@/lib/metrics'
import { data, useApp, type InspectorTab } from '@/lib/store'
import { ST, PRIORITIES, type ProcInfo } from '@/lib/types'
import { Button, Chip, DropdownButton, Empty, Icon, IconButton, Meter, Row as _Row, Segmented, Spinner } from '@/ui'
import { avatarHue } from '../processes/rows'
import { Chart } from './Chart'
import { useHistory } from './useHistory'

void _Row

const TABS: { id: InspectorTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'resources', label: 'Resources' },
  { id: 'network', label: 'Network & files' },
  { id: 'environment', label: 'Environment' },
  { id: 'security', label: 'Security' },
]

export function Inspector({ pid }: { pid: number }) {
  const tick = useApp((s) => s.tick)
  const tab = useApp((s) => s.inspectorTab)
  const settings = useApp((s) => s.settings)
  const caps = useApp((s) => s.info?.capabilities)
  const netSupported = useApp((s) => s.netSupported)
  const live = data.live.get(pid)
  const cur = data.procs.get(pid)
  const lastKnown = useRef<ProcInfo | undefined>(cur)
  if (cur) lastKnown.current = cur
  if (lastKnown.current?.pid !== pid) lastKnown.current = cur
  const p = cur ?? lastKnown.current
  const gone = !cur
  const scale = useMemo(() => scaleFrom(settings, data.sys?.cores ?? 1, data.sys?.mem_total ?? 1), [settings, tick]) // eslint-disable-line react-hooks/exhaustive-deps
  const close = () => useApp.setState({ selected: null, multi: new Set() })

  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && !(e.target instanceof HTMLInputElement) && !document.querySelector('[role=dialog]') && close()
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])

  if (!p) return null
  const stopped = live?.st === ST.STOP
  const protectedProc = isProtected(p.name)
  const hue = avatarHue(p.app ?? p.name)

  return (
    <aside className="glass slide-in flex min-h-0 w-[min(440px,42vw)] min-w-[330px] flex-none flex-col overflow-hidden rounded-2xl" aria-label={`Inspector for ${p.name}`}>
      <div className="flex items-start gap-3 px-4 pb-2 pt-3.5">
        <span className="grid h-10 w-10 flex-none place-items-center rounded-xl text-[17px] font-bold text-white shadow-md" style={{ background: `linear-gradient(135deg, hsl(${hue} 62% 58%), hsl(${hue + 20} 70% 38%))` }}>
          {p.name.replace(/[^A-Za-z0-9]/g, '').charAt(0).toUpperCase() || '·'}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="selectable truncate text-[16px] font-semibold leading-tight">{p.name}</h2>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[12px] text-faint">
            <span className="num">PID {p.pid}</span>
            {p.user && <span>· {p.user}</span>}
            {gone && <Chip kind="crit">Exited</Chip>}
            {stopped && <Chip kind="warn">Suspended</Chip>}
            {protectedProc && <Chip kind="warn" title="Core system process">System</Chip>}
          </div>
        </div>
        <IconButton icon="x" label="Close inspector" onClick={close} />
      </div>

      {live && !gone && (
        <div className="grid grid-cols-2 gap-2 px-4 pb-2">
          <MiniMeter icon="cpu" label="CPU" pct={cpuPct(live.cpu, scale)} value={fmtPct(cpuPct(live.cpu, scale))} />
          <MiniMeter icon="mem" label="Memory" pct={memPct(live.mem, scale)} value={fmtBytes(live.mem)} sub={fmtPct(memPct(live.mem, scale)) + ' of RAM'} />
          <MiniMeter icon="disk" label="Disk" pct={diskPct(live.dr + live.dw, scale)} value={fmtRate(live.dr + live.dw)} sub={`R ${fmtBytes(live.dr, 0)} · W ${fmtBytes(live.dw, 0)}`} />
          <MiniMeter icon="net" label="Network" pct={netPct(live.nr + live.nw, scale)} value={netSupported ? fmtRate(live.nr + live.nw) : 'n/a'} sub={netSupported ? `↓ ${fmtBytes(live.nr, 0)} ↑ ${fmtBytes(live.nw, 0)}` : undefined} />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5 border-y border-line px-4 py-2">
        <Button small variant="primary" onClick={() => trackProcs([pid])} disabled={gone}><Icon name="record" size={11} />Track</Button>
        {caps?.suspend !== false && (stopped
          ? <Button small onClick={() => resumeProc(pid)} disabled={gone}><Icon name="play" size={11} />Resume</Button>
          : <Button small onClick={() => suspendProc(pid)} disabled={gone}><Icon name="pause" size={12} />Suspend</Button>)}
        <DropdownButton small variant="danger" label="Stop" icon="kill" disabled={gone} items={[
          { label: 'Terminate (graceful)', icon: 'kill', onSelect: () => terminateProc(pid) },
          { label: 'Force quit', icon: 'kill', danger: true, onSelect: () => terminateProc(pid, { force: true }) },
          { label: 'Terminate process tree', icon: 'tree', danger: true, onSelect: () => terminateProc(pid, { tree: true }) },
        ]} />
        <Button small onClick={() => relaunchProc(pid)} disabled={gone}><Icon name="refresh" size={12} />Relaunch</Button>
        {caps?.focus_window && <Button small onClick={() => focusProc(pid)} disabled={gone} title="Bring this process's window to the front"><Icon name="window" size={12} />Focus</Button>}
        <Button small className="ml-auto" onClick={() => askAi(pid)}><Icon name="sparkles" size={12} />Ask AI</Button>
      </div>

      <div className="flex gap-0.5 overflow-x-auto px-3 pt-2" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => useApp.setState({ inspectorTab: t.id })}
            className={`relative h-7 flex-none rounded-lg px-2.5 text-[12.5px] font-medium ${tab === t.id ? 'bg-selected text-fg' : 'text-dim hover:text-fg'}`}>
            {t.label}
          </button>
        ))}
      </div>

      <div className="selectable min-h-0 flex-1 overflow-auto px-4 pb-4 pt-3" role="tabpanel">
        {gone && <div className="mb-3 rounded-lg bg-crit/10 px-3 py-2 text-[12px] text-crit">This process has exited. Showing its last known details.</div>}
        {tab === 'overview' && <Overview pid={pid} p={p} gone={gone} />}
        {tab === 'resources' && <Resources pid={pid} />}
        {tab === 'network' && <NetworkFiles pid={pid} gone={gone} />}
        {tab === 'environment' && <Environment pid={pid} gone={gone} />}
        {tab === 'security' && <Security pid={pid} gone={gone} p={p} />}
      </div>
    </aside>
  )
}

function MiniMeter(props: { icon: string; label: string; pct: number; value: string; sub?: string }) {
  return <Meter {...props} sub={props.sub} />
}

// ------------------------------------------------------------------ overview

function KV({ k, children, mono }: { k: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[96px_1fr] gap-3 border-b border-line py-2 last:border-0">
      <div className="text-[12px] text-faint">{k}</div>
      <div className={`min-w-0 break-words ${mono ? 'font-mono text-[11.5px]' : ''}`}>{children}</div>
    </div>
  )
}

function Overview({ pid, p, gone }: { pid: number; p: ProcInfo; gone: boolean }) {
  const [reveal, setReveal] = useState(false)
  const d = useAsync(() => api.details(pid, reveal), [pid, reveal], !gone)
  const anomalies = useApp((s) => s.anomalies)
  const mine = anomalies.filter((a) => a.pid === pid && !a.dismissed)
  const caps = useApp((s) => s.info?.capabilities)
  const det = d.data
  const live = data.live.get(pid)
  const cmd = det?.cmd ?? p.cmd
  return (
    <div>
      {mine.length > 0 && (
        <div className="mb-3 space-y-1.5">
          {mine.slice(0, 3).map((a) => (
            <div key={a.id} className={`rounded-lg px-3 py-2 text-[12px] ${a.severity === 'critical' ? 'bg-crit/10 text-crit' : 'bg-warn/10 text-warn'}`}>
              <div className="font-semibold">{a.title}</div>
              <div className="mt-0.5 text-dim">{a.detail}</div>
            </div>
          ))}
        </div>
      )}
      <KV k="Path" mono>
        {p.exe ? <button className="text-left hover:underline" onClick={() => copyText(p.exe!, 'Path copied')} title="Click to copy">{p.exe}</button> : <span className="text-faint">Unavailable (restricted)</span>}
      </KV>
      <KV k="Command" mono>
        <div className="flex items-start gap-2">
          <span className="flex-1">{cmd.length ? cmd.join(' ') : <span className="text-faint">Unavailable</span>}</span>
          <button className="icon-btn !h-5 !w-5 flex-none" title={reveal ? 'Hide sensitive values' : 'Reveal sensitive values'} aria-label="Toggle sensitive values" onClick={() => setReveal(!reveal)}><Icon name={reveal ? 'eyeoff' : 'eye'} size={13} /></button>
        </div>
        {!reveal && cmd.some((c) => c.includes('••')) && <div className="mt-1 text-[11px] text-faint">Secret-looking values are masked.</div>}
      </KV>
      <KV k="Working dir" mono>{det?.cwd ?? <span className="text-faint">{d.loading ? '…' : 'Unavailable'}</span>}</KV>
      <KV k="Started">{p.start ? <>{fmtDateTime(p.start * 1000)} <span className="text-faint">· up {fmtDuration(Date.now() / 1000 - p.start)}</span></> : '–'}</KV>
      {caps?.threads && <KV k="Threads"><span className="num">{live?.thr ?? '–'}</span></KV>}
      {caps?.priority && (
        <KV k="Priority">
          <div className="flex items-center gap-2">
            <span>{PRIORITIES.find((x) => x.id === det?.priority?.level)?.label ?? '–'}</span>
            {det?.priority && <span className="text-[11px] text-faint">({det.priority.raw})</span>}
            <DropdownButton small label="Change" items={PRIORITIES.map((x) => ({ label: x.label, checked: det?.priority?.level === x.id, onSelect: () => setPriorityProc(pid, x.id).then(d.reload) }))} disabled={gone} />
          </div>
        </KV>
      )}
      <KV k="Parents">
        {det?.parents.length ? (
          <div className="flex flex-wrap items-center gap-1">
            {[...det.parents].reverse().map((r) => (
              <span key={r.pid} className="flex items-center gap-1">
                <button className="chip hover:bg-selected" onClick={() => inspect(r.pid)}>{r.name} <span className="num opacity-60">{r.pid}</span></button>
                <Icon name="chevR" size={11} className="text-faint" />
              </span>
            ))}
            <Chip kind="ok">{p.name}</Chip>
          </div>
        ) : <span className="text-faint">{d.loading ? '…' : 'None (top-level)'}</span>}
      </KV>
      <KV k="Children">
        {det?.children.length ? (
          <div className="flex flex-wrap gap-1">
            {det.children.slice(0, 24).map((r) => <button key={r.pid} className="chip hover:bg-selected" onClick={() => inspect(r.pid)}>{r.name} <span className="num opacity-60">{r.pid}</span></button>)}
            {det.children.length > 24 && <span className="text-faint">+{det.children.length - 24} more</span>}
          </div>
        ) : <span className="text-faint">{d.loading ? '…' : 'None'}</span>}
      </KV>
      {p.app_path && <KV k="App bundle" mono>{p.app_path}</KV>}
      {d.error && <div className="mt-2 text-[12px] text-crit">{d.error}</div>}
    </div>
  )
}

// ------------------------------------------------------------------ resources

function Resources({ pid }: { pid: number }) {
  const [tier, setTier] = useState<'hi' | 'lo'>('hi')
  const h = useHistory(pid, tier)
  const settings = useApp((s) => s.settings)
  const netSupported = useApp((s) => s.netSupported)
  const sys = data.sys
  const scale = scaleFrom(settings, sys?.cores ?? 1, sys?.mem_total ?? 1)
  const cpu = useMemo(() => h.cpu.map((v) => cpuPct(v, scale)), [h, scale.cores, scale.perCore]) // eslint-disable-line react-hooks/exhaustive-deps
  const memMb = useMemo(() => h.mem.map((k) => k / 1024), [h])
  const mb = (n: number[]) => n.map((v) => v / 1048576)
  const kb = (n: number[]) => n.map((v) => v / 1024)
  const memTotalMb = scale.memTotal / 1048576
  const last = (a: number[]) => (a.length ? a[a.length - 1] : 0)
  const bands = scale.perCore ? undefined : [{ value: 70, color: 'var(--lvl-warn)' }, { value: 90, color: 'var(--lvl-crit)' }]
  const unit = h.t.length ? `${Math.round((h.t[h.t.length - 1] - h.t[0]) / 60)} min shown` : ''
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Segmented<'hi' | 'lo'> value={tier} onChange={setTier} label="History range" options={[{ id: 'hi', label: '10 min' }, { id: 'lo', label: '1 hour' }]} />
        <span className="text-[11.5px] text-faint">{unit}</span>
      </div>
      {h.t.length < 2 ? <Empty icon="clock" title="Collecting history…">Charts fill in as data arrives.</Empty> : (
        <>
          <ChartBlock title="CPU" icon="cpu" now={fmtPct(last(cpu))}>
            <Chart t={h.t} series={[{ label: 'CPU', color: 'var(--lvl-normal)', values: cpu }]} unit={(v) => `${Math.round(v)}%`} yMax={scale.perCore ? 100 : 100} bands={bands} />
          </ChartBlock>
          <ChartBlock title="Memory" icon="mem" now={fmtBytes(last(memMb) * 1048576)}>
            <Chart t={h.t} series={[{ label: 'Memory', color: 'var(--accent-2)', values: memMb }]} unit={(v) => (v >= 1024 ? `${(v / 1024).toFixed(1)}G` : `${Math.round(v)}M`)} bands={[{ value: memTotalMb * 0.7, color: 'var(--lvl-warn)' }, { value: memTotalMb * 0.9, color: 'var(--lvl-crit)' }]} />
          </ChartBlock>
          <ChartBlock title="Disk I/O" icon="disk" now={fmtRate(last(h.dr) + last(h.dw))}>
            <Chart t={h.t} series={[{ label: 'Read', color: '#38bdf8', values: mb(h.dr) }, { label: 'Write', color: '#a78bfa', values: mb(h.dw) }]} unit={(v) => `${v < 10 ? v.toFixed(1) : Math.round(v)}M`} />
            <Legend items={[['Read', '#38bdf8'], ['Write', '#a78bfa']]} />
          </ChartBlock>
          <ChartBlock title="Network" icon="net" now={netSupported ? fmtRate(last(h.nr) + last(h.nw)) : 'n/a'}>
            {netSupported ? (
              <>
                <Chart t={h.t} series={[{ label: 'In', color: '#2dd4bf', values: kb(h.nr) }, { label: 'Out', color: '#f59e0b', values: kb(h.nw) }]} unit={(v) => (v >= 1024 ? `${(v / 1024).toFixed(1)}M` : `${Math.round(v)}K`)} />
                <Legend items={[['In', '#2dd4bf'], ['Out', '#f59e0b']]} />
              </>
            ) : <div className="py-6 text-center text-[12px] text-faint">Per-process network usage isn't available on this platform.</div>}
          </ChartBlock>
        </>
      )}
    </div>
  )
}

function ChartBlock({ title, icon, now, children }: { title: string; icon: string; now: string; children: React.ReactNode }) {
  return (
    <div className="glass-flat rounded-xl p-3">
      <div className="mb-1 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-[12px] font-semibold text-dim"><Icon name={icon} size={13} />{title}</span>
        <span className="num text-[12px] font-semibold">{now}</span>
      </div>
      {children}
    </div>
  )
}
const Legend = ({ items }: { items: [string, string][] }) => (
  <div className="mt-1 flex gap-3 text-[11px] text-faint">{items.map(([l, c]) => <span key={l} className="flex items-center gap-1"><i className="inline-block h-2 w-2 rounded-full" style={{ background: c }} />{l}</span>)}</div>
)

// ------------------------------------------------------------------ network & files

function NetworkFiles({ pid, gone }: { pid: number; gone: boolean }) {
  const caps = useApp((s) => s.info?.capabilities)
  const [filter, setFilter] = useState('')
  const conns = useAsync(() => api.connections(pid), [pid], !gone && !!caps?.connections)
  const files = useAsync(() => api.openFiles(pid), [pid], !gone && !!caps?.open_files)
  const fl = files.data?.filter((f) => !filter || f.name.toLowerCase().includes(filter.toLowerCase())) ?? []
  return (
    <div className="space-y-5">
      <section>
        <div className="mb-1.5 flex items-center justify-between"><span className="label">Connections & listening ports</span><IconButton icon="refresh" label="Refresh" size={13} onClick={conns.reload} /></div>
        {!caps?.connections ? <div className="text-faint">Not available on this platform.</div> : conns.loading && !conns.data ? <Spinner /> : conns.error ? <div className="text-crit">{conns.error}</div> : !conns.data?.length ? <div className="text-faint">No open sockets (or not permitted to read them).</div> : (
          <div className="overflow-hidden rounded-xl border border-line">
            {conns.data.map((c, i) => (
              <div key={i} className="flex items-center gap-2 border-b border-line px-3 py-1.5 font-mono text-[11.5px] last:border-0">
                <Chip kind={c.state === 'LISTEN' ? 'ok' : undefined}>{c.proto}</Chip>
                <span className="min-w-0 flex-1 truncate">{c.local}{c.remote ? ` → ${c.remote}` : ''}</span>
                {c.state && <span className="text-faint">{c.state}</span>}
              </div>
            ))}
          </div>
        )}
      </section>
      <section>
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <span className="label">Open files {files.data ? `(${files.data.length})` : ''}</span>
          <div className="flex items-center gap-1">
            <input className="input !h-6 !w-36 !text-[11.5px]" placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter open files" />
            <IconButton icon="refresh" label="Refresh" size={13} onClick={files.reload} />
          </div>
        </div>
        {!caps?.open_files ? <div className="text-faint">Not available on this platform.</div> : files.loading && !files.data ? <Spinner /> : files.error ? <div className="text-crit">{files.error}</div> : !fl.length ? <div className="text-faint">Nothing to show.</div> : (
          <div className="max-h-[300px] overflow-auto rounded-xl border border-line">
            {fl.slice(0, 400).map((f, i) => (
              <div key={i} className="flex gap-2 border-b border-line px-3 py-1 font-mono text-[11px] last:border-0">
                <span className="w-9 flex-none text-faint">{f.fd}</span>
                <span className="w-9 flex-none text-faint">{f.kind}</span>
                <span className="min-w-0 flex-1 break-all">{f.name}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

// ------------------------------------------------------------------ environment

function Environment({ pid, gone }: { pid: number; gone: boolean }) {
  const [reveal, setReveal] = useState(false)
  const [q, setQ] = useState('')
  const d = useAsync(() => api.details(pid, reveal), [pid, reveal], !gone)
  const env = d.data?.env.filter(([k, v]) => !q || k.toLowerCase().includes(q.toLowerCase()) || v.toLowerCase().includes(q.toLowerCase())) ?? []
  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <input className="input !h-7" placeholder="Filter variables…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter environment" />
        <Button small onClick={() => setReveal(!reveal)}><Icon name={reveal ? 'eyeoff' : 'eye'} size={12} />{reveal ? 'Hide secrets' : 'Reveal secrets'}</Button>
      </div>
      {d.loading && !d.data ? <Spinner /> : !d.data?.env.length ? <div className="text-faint">The environment isn't readable for this process (it belongs to another user or is protected).</div> : (
        <div className="overflow-hidden rounded-xl border border-line">
          {env.map(([k, v]) => (
            <div key={k} className="grid grid-cols-[130px_1fr] gap-2 border-b border-line px-3 py-1.5 font-mono text-[11.5px] last:border-0">
              <span className="truncate text-faint" title={k}>{k}</span>
              <span className="break-all">{v}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ security

const SUSPECT = /(\/tmp\/|\/private\/tmp\/|\/dev\/shm\/|\/downloads\/|\\temp\\|\\downloads\\)/i

function Security({ pid, gone, p }: { pid: number; gone: boolean; p: ProcInfo }) {
  const caps = useApp((s) => s.info?.capabilities)
  const sig = useAsync(() => api.signature(pid), [pid], !gone && !!caps?.signature)
  const s = sig.data
  const odd = p.exe ? SUSPECT.test(p.exe) : false
  return (
    <div className="space-y-3">
      {!caps?.signature ? <div className="text-faint">Signature checks aren't available on this platform.</div> : sig.loading ? <div className="flex items-center gap-2 text-dim"><Spinner />Verifying signature…</div> : sig.error ? <div className="text-crit">{sig.error}</div> : s && (
        <div className="glass-flat rounded-xl p-3">
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            {s.signed ? <Chip kind="ok"><Icon name="shield" size={11} />Signed</Chip> : <Chip kind="warn"><Icon name="alert" size={11} />Not signed</Chip>}
            {s.valid === true && <Chip kind="ok">Valid</Chip>}
            {s.valid === false && <Chip kind="crit">Signature invalid</Chip>}
            {s.notarized === true && <Chip kind="ok">Notarized</Chip>}
            {s.notarized === false && s.signed && <Chip>Not notarized</Chip>}
          </div>
          {s.identifier && <KV k="Identifier" mono>{s.identifier}</KV>}
          {s.team_id && <KV k="Team ID" mono>{s.team_id}</KV>}
          {s.authority.length > 0 && <KV k="Authority">{s.authority.map((a, i) => <div key={i} className="text-[12px]">{i > 0 && <span className="text-faint">↳ </span>}{a}</div>)}</KV>}
          {s.note && <div className="mt-1 text-[12px] text-dim">{s.note}</div>}
          {!s.signed && <div className="mt-1 text-[12px] text-dim">Unsigned is common for command-line tools and developer builds. It is not by itself a sign of a problem.</div>}
        </div>
      )}
      <div className="glass-flat rounded-xl p-3 text-[12.5px]">
        <div className="mb-1 font-semibold">Quick context</div>
        <ul className="list-disc space-y-1 pl-4 text-dim">
          <li>Started {fmtAgo(p.start * 1000)}{p.user ? ` by ${p.user}` : ''}.</li>
          <li>{p.exe ? (odd ? 'Runs from a temporary or Downloads folder, which installers and updaters often do; it is also an unusual place for permanent software.' : `Runs from ${basename(p.exe)} in a normal location.`) : 'Executable path is not readable, so its location cannot be assessed.'}</li>
        </ul>
        <div className="mt-2 text-[11.5px] text-faint">DeRunner highlights signals to review. It never labels a process as malware.</div>
      </div>
    </div>
  )
}
