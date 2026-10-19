import { useVirtualizer } from '@tanstack/react-virtual'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { buildProcMenu, trackProcs } from '@/lib/actions'
import { basename, fmtBytes, fmtPct, fmtRate } from '@/lib/format'
import { cpuPct, diskPct, memPct, netPct, scaleFrom, type Scale } from '@/lib/metrics'
import { data, ls, showMenu, sparkValues, useApp, type SortKey, type ViewMode } from '@/lib/store'
import { level } from '@/lib/thresholds'
import { ST } from '@/lib/types'
import { Button, Chip, DropdownButton, Empty, Icon, Segmented, Sparkline, UsageCell } from '@/ui'
import { avatarHue, buildRows, type FlatRow } from './rows'

interface Col {
  id: string
  label: string
  width: string
  /** Minimum px needed; columns are hidden (lowest priority first) when the table is too narrow. */
  min: number
  sort?: SortKey
}

const COLS: Col[] = [
  { id: 'name', label: 'Process', width: 'minmax(180px, 2.4fr)', min: 200, sort: 'name' },
  { id: 'cpu', label: 'CPU', width: '118px', min: 118, sort: 'cpu' },
  { id: 'mem', label: 'Memory', width: '100px', min: 100, sort: 'mem' },
  { id: 'disk', label: 'Disk', width: '104px', min: 104, sort: 'disk' },
  { id: 'net', label: 'Network', width: '104px', min: 104, sort: 'net' },
  { id: 'thr', label: 'Threads', width: '64px', min: 64, sort: 'thr' },
  { id: 'pid', label: 'PID', width: '64px', min: 64, sort: 'pid' },
  { id: 'user', label: 'User', width: '92px', min: 92, sort: 'user' },
]
const DEFAULT_COLS = ['name', 'cpu', 'mem', 'disk', 'net', 'thr', 'pid']

export function ProcessList() {
  const tick = useApp((s) => s.tick)
  const { query, sortKey, sortDir, viewMode, collapsed, expandedApps, selected, multi, settings, netSupported, lockOrder, frozenRank } = useApp()
  const anomalies = useApp((s) => s.anomalies)
  const [hotOnly, setHotOnly] = useState(false)
  const [cols, setCols] = useState<string[]>(() => ls.get('cols', DEFAULT_COLS))
  const scroller = useRef<HTMLDivElement>(null)

  const scale = useMemo<Scale>(() => scaleFrom(settings, data.sys?.cores ?? 1, data.sys?.mem_total ?? 1), [settings, tick]) // eslint-disable-line react-hooks/exhaustive-deps
  const frozen = lockOrder ? frozenRank : null
  const rows = useMemo(
    () => buildRows({ query, sortKey, sortDir, mode: viewMode, collapsed, expandedApps, hotOnly, scale, frozen }),
    [tick, query, sortKey, sortDir, viewMode, collapsed, expandedApps, hotOnly, scale, frozen], // eslint-disable-line react-hooks/exhaustive-deps
  )

  // Engage the lock: remember where every process sits right now (ignoring search/filters, so rows that are
  // hidden at the moment keep a sensible place when they come back). Re-captured after sort / view changes.
  useEffect(() => {
    if (!lockOrder || frozenRank || !data.procs.size) return
    const all = buildRows({ query: '', sortKey, sortDir, mode: viewMode, collapsed, expandedApps, hotOnly: false, scale })
    useApp.setState({ frozenRank: new Map(all.map((r, i) => [r.key, i])) })
  }, [lockOrder, frozenRank, rows.length]) // eslint-disable-line react-hooks/exhaustive-deps
  const anomPids = useMemo(() => new Set(anomalies.filter((a) => !a.dismissed && a.severity !== 'info').map((a) => a.pid)), [anomalies])

  const [width, setWidth] = useState(900)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])
  const active = useMemo(() => {
    const chosen = COLS.filter((c) => cols.includes(c.id))
    const drop = ['user', 'pid', 'thr', 'net', 'disk', 'mem']
    let total = chosen.reduce((a, c) => a + c.min, 0) + 24
    for (const id of drop) {
      if (total <= width) break
      const i = chosen.findIndex((c) => c.id === id)
      if (i >= 0) { total -= chosen[i].min; chosen.splice(i, 1) }
    }
    return chosen
  }, [cols, width])
  const template = active.map((c) => c.width).join(' ')

  const virt = useVirtualizer({ count: rows.length, getScrollElement: () => scroller.current, estimateSize: () => 36, overscan: 14 })

  // Keep the selected row in view when it changes via keyboard / palette.
  const selIndex = useMemo(() => rows.findIndex((r) => r.pid === selected && r.kind === 'proc'), [rows, selected])
  const lastSel = useRef<number | null>(null)
  useEffect(() => {
    if (selected !== lastSel.current && selIndex >= 0) virt.scrollToIndex(selIndex, { align: 'auto' })
    lastSel.current = selected
  }, [selected, selIndex]) // eslint-disable-line react-hooks/exhaustive-deps

  const setSort = (k: SortKey) => {
    const dir = sortKey === k ? ((sortDir * -1) as 1 | -1) : k === 'name' || k === 'user' ? 1 : -1
    ls.put('sortKey', k)
    ls.put('sortDir', dir)
    useApp.setState({ sortKey: k, sortDir: dir, frozenRank: null }) // re-freeze in the new order
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const procRows = rows.filter((r) => r.kind === 'proc' || r.kind === 'group')
    const i = procRows.findIndex((r) => r.pid === selected)
    const next = procRows[Math.max(0, Math.min(procRows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]
    if (next) useApp.setState({ selected: next.pid })
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <Toolbar total={rows.length} hotOnly={hotOnly} setHotOnly={setHotOnly} cols={cols} setCols={setCols} />
      <div ref={box} className="glass flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl">
        <div className="thead border-b border-line" style={{ gridTemplateColumns: template, paddingLeft: 18, paddingRight: 28 }}>
          {active.map((c) => (
            <div key={c.id} className="min-w-0 pr-2">
              {c.sort ? (
                <button onClick={() => setSort(c.sort!)} aria-label={`Sort by ${c.label}`}>
                  {c.label}
                  {sortKey === c.sort && <Icon name={sortDir === 1 ? 'chevU' : 'chevD'} size={11} />}
                </button>
              ) : c.label}
            </div>
          ))}
        </div>
        <div ref={scroller} tabIndex={0} onKeyDown={onKey} className="min-h-0 flex-1 overflow-auto px-1.5 py-1 outline-none [scrollbar-gutter:stable]" role="grid" aria-rowcount={rows.length}>
          {rows.length === 0 ? (
            <Empty icon="search" title={data.procs.size ? 'No matching processes' : 'Waiting for data…'}>
              {data.procs.size ? 'Try a different search, or turn off the “Hot only” filter.' : undefined}
            </Empty>
          ) : (
            <div style={{ height: virt.getTotalSize(), position: 'relative' }}>
              {virt.getVirtualItems().map((v) => {
                const r = rows[v.index]
                return (
                  <div key={r.key} style={{ position: 'absolute', top: 0, left: 0, right: 0, height: v.size, transform: `translateY(${v.start}px)` }}>
                    <ProcRow row={r} viewMode={viewMode} cols={active} template={template} scale={scale} selected={selected === r.pid} multi={multi.has(r.pid)} hasAnomaly={anomPids.has(r.pid)} netSupported={netSupported} />
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export function toggleLock() {
  const on = !useApp.getState().lockOrder
  ls.put('lockOrder', on)
  useApp.setState({ lockOrder: on, frozenRank: null })
}

function Toolbar({ total, hotOnly, setHotOnly, cols, setCols }: { total: number; hotOnly: boolean; setHotOnly: (b: boolean) => void; cols: string[]; setCols: (c: string[]) => void }) {
  const { query, viewMode, multi, selected, collapsed, lockOrder } = useApp()
  const searchRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === '/' && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault()
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])
  const trackIds = multi.size ? [...multi] : selected != null ? [selected] : []
  return (
    <div className="mb-2.5 flex flex-wrap items-center gap-2">
      <div className="relative min-w-[200px] max-w-[420px] flex-1">
        <Icon name="search" size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
        <input ref={searchRef} className="input !pl-8 !pr-14" placeholder="Search name, PID, user, path, command…" value={query} onChange={(e) => useApp.setState({ query: e.target.value })} onKeyDown={(e) => e.key === 'Escape' && (useApp.setState({ query: '' }), searchRef.current?.blur())} aria-label="Search processes" spellCheck={false} />
        {query ? (
          <button className="icon-btn absolute right-1 top-1/2 -translate-y-1/2" onClick={() => useApp.setState({ query: '' })} aria-label="Clear search"><Icon name="x" size={13} /></button>
        ) : (
          <span className="absolute right-2 top-1/2 -translate-y-1/2"><span className="kbd">/</span></span>
        )}
      </div>
      <Segmented<ViewMode>
        value={viewMode}
        label="View mode"
        onChange={(v) => { ls.put('viewMode', v); useApp.setState({ viewMode: v, frozenRank: null }) }}
        options={[
          { id: 'list', label: <><Icon name="list" size={13} />List</>, title: 'Flat list' },
          { id: 'tree', label: <><Icon name="tree" size={13} />Tree</>, title: 'Parent → child hierarchy' },
          { id: 'apps', label: <><Icon name="apps" size={13} />Apps</>, title: 'Group helpers with their app' },
        ]}
      />
      <button
        className={`btn btn-sm !w-[26px] !px-0 ${lockOrder ? '!border-accent/50 !bg-accent-soft !text-accent' : ''}`}
        aria-pressed={lockOrder}
        aria-label={lockOrder ? 'Unlock row order' : 'Lock row order'}
        title={lockOrder ? 'Row order is locked: values keep updating but rows stay put. Click to unlock.' : 'Lock row order so rows stop jumping around while you read'}
        onClick={toggleLock}
      >
        <Icon name={lockOrder ? 'lock' : 'unlock'} size={14} />
      </button>
      <Button small onClick={() => setHotOnly(!hotOnly)} aria-pressed={hotOnly} className={hotOnly ? '!border-warn/50 !bg-warn/15 !text-warn' : ''} title="Show only processes at or above 70% on any metric">
        <Icon name="bolt" size={13} />Hot only
      </Button>
      {viewMode === 'tree' && (
        <Button small onClick={() => {
          const all = new Set<number>()
          if (collapsed.size === 0) for (const p of data.procs.values()) if (p.ppid && data.procs.has(p.ppid)) all.add(p.ppid)
          useApp.setState({ collapsed: all })
        }} title="Expand or collapse every branch">{collapsed.size === 0 ? 'Collapse all' : 'Expand all'}</Button>
      )}
      <div className="ml-auto flex items-center gap-2">
        <span className="num text-[12px] text-faint">{total.toLocaleString()} {viewMode === 'list' ? 'processes' : 'rows'}</span>
        <DropdownButton small label="Columns" icon="sliders" items={COLS.filter((c) => c.id !== 'name').map((c) => ({ label: c.label, checked: cols.includes(c.id), onSelect: () => { const n = cols.includes(c.id) ? cols.filter((x) => x !== c.id) : [...cols, c.id]; ls.put('cols', n); setCols(n) } }))} />
        <Button small variant="primary" disabled={!trackIds.length} onClick={() => trackProcs(trackIds)} title="Record detailed telemetry for the selected process(es)">
          <Icon name="record" size={12} />Track{trackIds.length > 1 ? ` ${trackIds.length}` : ''}
        </Button>
      </div>
    </div>
  )
}

const ProcRow = memo(function ProcRow({ row, viewMode, cols, template, scale, selected, multi, hasAnomaly, netSupported }: { row: FlatRow; viewMode: ViewMode; cols: Col[]; template: string; scale: Scale; selected: boolean; multi: boolean; hasAnomaly: boolean; netSupported: boolean }) {
  const p = data.procs.get(row.pid)
  const live = data.live.get(row.pid)
  const v = row.agg ?? live
  if (!p) return null
  const isGroup = row.kind === 'group'
  const name = isGroup ? row.label : p.name
  const stopped = !isGroup && live?.st === ST.STOP
  const zombie = !isGroup && live?.st === ST.ZOMBIE

  const onClick = (e: React.MouseEvent) => {
    const st = useApp.getState()
    if (e.metaKey || e.ctrlKey) {
      const m = new Set(st.multi)
      m.has(row.pid) ? m.delete(row.pid) : m.add(row.pid)
      useApp.setState({ multi: m, selected: st.selected ?? row.pid })
      return
    }
    if (isGroup || row.hasChildren) {
      if (isGroup) {
        const s = new Set(st.expandedApps)
        s.has(row.label) ? s.delete(row.label) : s.add(row.label)
        useApp.setState({ expandedApps: s })
      }
    }
    useApp.setState({ selected: row.pid, multi: new Set() })
  }
  const toggleTree = (e: React.MouseEvent) => {
    e.stopPropagation()
    const st = useApp.getState()
    if (isGroup) {
      const s = new Set(st.expandedApps)
      s.has(row.label) ? s.delete(row.label) : s.add(row.label)
      useApp.setState({ expandedApps: s })
    } else {
      const s = new Set(st.collapsed)
      s.has(row.pid) ? s.delete(row.pid) : s.add(row.pid)
      useApp.setState({ collapsed: s })
    }
  }

  const cell = (c: Col) => {
    switch (c.id) {
      case 'name':
        return (
          <div className="flex min-w-0 items-center gap-2" style={{ paddingLeft: row.depth * 16 }}>
            {row.hasChildren ? (
              <button className="icon-btn !h-5 !w-5 flex-none" onClick={toggleTree} aria-label={row.expanded ? 'Collapse' : 'Expand'} aria-expanded={row.expanded}>
                <Icon name={row.expanded ? 'chevD' : 'chevR'} size={12} />
              </button>
            ) : viewMode !== 'list' ? <span className="w-5 flex-none" /> : null}
            <span className="grid h-[22px] w-[22px] flex-none place-items-center rounded-md text-[11px] font-bold text-white" style={{ background: `linear-gradient(135deg, hsl(${avatarHue(p.app ?? name)} 62% 58%), hsl(${avatarHue(p.app ?? name) + 20} 70% 38%))` }}>
              {name.replace(/[^A-Za-z0-9]/g, '').charAt(0).toUpperCase() || '·'}
            </span>
            <div className="min-w-0 leading-tight">
              <div className="flex items-center gap-1.5">
                <span className="truncate font-medium">{name}</span>
                {isGroup && <Chip>{row.count}</Chip>}
                {!isGroup && row.hasChildren && !row.expanded && <Chip title="Rolled-up totals of hidden children">+{row.count - 1}</Chip>}
                {stopped && <Chip kind="warn">Suspended</Chip>}
                {zombie && <Chip kind="warn">Zombie</Chip>}
                {hasAnomaly && <span className="text-warn" title="Unusual behaviour detected. See Anomalies."><Icon name="alert" size={13} /></span>}
              </div>
              <div className="truncate text-[10.5px] text-faint">{isGroup ? `${row.count} processes` : p.app && p.app !== p.name ? p.app : basename(p.exe) || p.user || ''}</div>
            </div>
          </div>
        )
      case 'cpu': {
        if (!v) return null
        const pct = cpuPct(v.cpu, scale)
        const sp = sparkValues(row.pid)
        const lv = level(pct)
        return (
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1"><UsageCell pct={Math.min(100, pct)} text={fmtPct(pct)} level={lv} /></div>
            {!isGroup && <Sparkline values={sp} level={lv} width={34} height={16} max={Math.max(10, ...sp)} />}
          </div>
        )
      }
      case 'mem': {
        if (!v) return null
        const pct = memPct(v.mem, scale)
        return <UsageCell pct={pct} text={fmtBytes(v.mem)} sub={pct >= 1 ? fmtPct(pct) + ' of RAM' : undefined} />
      }
      case 'disk': {
        if (!v) return null
        const t = v.dr + v.dw
        return <UsageCell pct={diskPct(t, scale)} text={t < 1 ? '0' : fmtRate(t)} sub={t >= 1 ? `R ${fmtBytes(v.dr, 0)} · W ${fmtBytes(v.dw, 0)}` : undefined} />
      }
      case 'net': {
        if (!v) return null
        if (!netSupported) return <span className="text-faint" title="Per-process network isn't available (unsupported OS or turned off in Settings)">n/a</span>
        const t = v.nr + v.nw
        return <UsageCell pct={netPct(t, scale)} text={t < 1 ? '0' : fmtRate(t)} sub={t >= 1 ? `↓ ${fmtBytes(v.nr, 0)} ↑ ${fmtBytes(v.nw, 0)}` : undefined} />
      }
      case 'thr':
        return <span className="num text-dim">{v?.thr || '–'}</span>
      case 'pid':
        return <span className="num text-dim">{isGroup ? '' : p.pid}</span>
      case 'user':
        return <span className="truncate text-dim">{p.user ?? ''}</span>
    }
  }

  return (
    <div
      className="trow"
      style={{ gridTemplateColumns: template }}
      data-selected={selected}
      data-multi={multi}
      role="row"
      aria-selected={selected}
      onClick={onClick}
      onContextMenu={(e) => {
        const st = useApp.getState()
        if (!st.multi.has(row.pid)) useApp.setState({ selected: row.pid, multi: new Set() })
        showMenu(e, buildProcMenu(row.pid))
      }}
    >
      {cols.map((c) => (
        <div key={c.id} className="min-w-0 pr-2" role="gridcell">{cell(c)}</div>
      ))}
    </div>
  )
})
