import { Command } from 'cmdk'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { askAi, focusProc, inspect, resumeProc, suspendProc, terminateProc, trackProcs } from '@/lib/actions'
import { fmtPct } from '@/lib/format'
import { api } from '@/lib/ipc'
import { cpuPct, scaleFrom } from '@/lib/metrics'
import { act, data, updateSettings, useApp, type View } from '@/lib/store'
import { ST } from '@/lib/types'
import { Icon, Kbd } from '@/ui'
import { toggleLock } from '../processes/ProcessTable'

interface Item {
  id: string
  label: string
  icon: string
  hint?: string
  keywords?: string
  run: () => void
}

const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)
const VIEWS: [View, string, string][] = [['processes', 'Processes', 'cpu'], ['ports', 'Ports & connections', 'plug'], ['sessions', 'Tracking sessions', 'record'], ['anomalies', 'Anomalies', 'alert'], ['rules', 'Priority rules', 'sliders'], ['assistant', 'Assistant', 'sparkles'], ['settings', 'Settings', 'gear']]

export function Palette() {
  const open = useApp((s) => s.paletteOpen)
  const selected = useApp((s) => s.selected)
  const settings = useApp((s) => s.settings)
  const paused = useApp((s) => s.paused)
  const [q, setQ] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const close = () => useApp.setState({ paletteOpen: false })

  useEffect(() => {
    if (open) { setQ(''); setTimeout(() => input.current?.focus(), 10) }
  }, [open])
  useEffect(() => {
    if (!open) return
    const h = (e: KeyboardEvent) => e.key === 'Escape' && close()
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [open])

  const { actions, procs } = useMemo(() => {
    if (!open) return { actions: [] as Item[], procs: [] as Item[] }
    const go = (fn: () => void) => () => { close(); fn() }
    const a: Item[] = []
    const sel = selected != null ? data.procs.get(selected) : null
    if (sel && selected != null) {
      const stopped = data.live.get(selected)?.st === ST.STOP
      a.push(
        { id: 'p-track', label: `Track ${sel.name}`, icon: 'record', run: go(() => trackProcs([selected])), keywords: 'record session' },
        { id: 'p-ai', label: `Ask the assistant about ${sel.name}`, icon: 'sparkles', run: go(() => askAi(selected)), keywords: 'explain ai' },
        stopped ? { id: 'p-resume', label: `Resume ${sel.name}`, icon: 'play', run: go(() => resumeProc(selected)) } : { id: 'p-suspend', label: `Suspend ${sel.name}`, icon: 'pause', run: go(() => suspendProc(selected)) },
        { id: 'p-term', label: `Terminate ${sel.name}`, icon: 'kill', run: go(() => terminateProc(selected)), keywords: 'quit kill stop' },
        { id: 'p-kill', label: `Force quit ${sel.name}`, icon: 'kill', run: go(() => terminateProc(selected, { force: true })), keywords: 'kill -9' },
        { id: 'p-focus', label: `Bring ${sel.name} window to front`, icon: 'window', run: go(() => focusProc(selected)) },
      )
    }
    for (const [v, label, icon] of VIEWS) a.push({ id: `v-${v}`, label: `Go to ${label}`, icon, run: go(() => useApp.getState().setView(v)), keywords: 'open navigate' })
    a.push(
      { id: 'lock', label: useApp.getState().lockOrder ? 'Unlock process order' : 'Lock process order', icon: useApp.getState().lockOrder ? 'unlock' : 'lock', keywords: 'freeze sort rows jump', run: go(toggleLock) },
      { id: 'theme', label: `Switch theme (now ${settings?.theme ?? 'system'})`, icon: 'eye', keywords: 'dark light appearance', run: go(() => updateSettings({ theme: settings?.theme === 'dark' ? 'light' : settings?.theme === 'light' ? 'system' : 'dark' })) },
      { id: 'glass', label: settings?.reduce_transparency ? 'Enable transparency' : 'Reduce transparency', icon: 'layers', run: go(() => updateSettings({ reduce_transparency: !settings?.reduce_transparency })) },
      { id: 'pause', label: paused ? 'Resume monitoring' : 'Pause monitoring', icon: paused ? 'play' : 'pause', run: go(() => { useApp.setState({ paused: !paused }); api.setPaused(!paused) }) },
      { id: 'update', label: 'Check for updates', icon: 'download', run: go(() => { useApp.getState().setView('settings', 'updates'); act(() => api.checkUpdate()) }) },
      { id: 'hide', label: 'Hide window to tray', icon: 'x', run: go(() => api.hideWindow()) },
      { id: 'quit', label: 'Quit DeRunner', icon: 'kill', run: go(() => api.quit()) },
    )
    const tokens = q.toLowerCase().split(/\s+/).filter(Boolean)
    const fa = tokens.length ? a.filter((i) => tokens.every((t) => `${i.label} ${i.keywords ?? ''}`.toLowerCase().includes(t))) : a.slice(0, 9)
    const scale = scaleFrom(settings, data.sys?.cores ?? 1, data.sys?.mem_total ?? 1)
    let ps = [...data.procs.values()]
    if (tokens.length) ps = ps.filter((p) => tokens.every((t) => `${p.name} ${p.pid} ${p.exe ?? ''} ${p.user ?? ''}`.toLowerCase().includes(t)))
    ps.sort((x, y) => (data.live.get(y.pid)?.cpu ?? 0) - (data.live.get(x.pid)?.cpu ?? 0))
    const pi: Item[] = ps.slice(0, tokens.length ? 30 : 6).map((p) => ({ id: `proc-${p.pid}`, label: p.name, icon: 'cpu', hint: `${p.pid} · ${fmtPct(cpuPct(data.live.get(p.pid)?.cpu ?? 0, scale))}`, run: go(() => inspect(p.pid)) }))
    return { actions: fa, procs: pi }
  }, [open, q, selected, settings, paused])

  if (!open) return null
  return createPortal(
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="glass-strong pop w-[620px] overflow-hidden rounded-2xl" role="dialog" aria-label="Command palette">
        <Command shouldFilter={false} loop>
          <div className="flex items-center">
            <Command.Input ref={input} value={q} onValueChange={setQ} placeholder="Search processes or run a command…" className="" />
            <span className="mr-4 flex-none"><Kbd>esc</Kbd></span>
          </div>
          <Command.List>
            <Command.Empty>No results</Command.Empty>
            {actions.length > 0 && (
              <Command.Group heading="Actions">
                {actions.map((i) => (
                  <Command.Item key={i.id} value={i.id} onSelect={i.run}>
                    <Icon name={i.icon} size={15} className="text-dim" /><span className="flex-1 truncate">{i.label}</span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}
            {procs.length > 0 && (
              <Command.Group heading={q ? 'Processes' : 'Top processes'}>
                {procs.map((i) => (
                  <Command.Item key={i.id} value={i.id} onSelect={i.run}>
                    <Icon name={i.icon} size={15} className="text-dim" /><span className="flex-1 truncate">{i.label}</span><span className="num text-[11.5px] text-faint">{i.hint}</span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}
          </Command.List>
          <div className="flex items-center gap-3 border-t border-line px-4 py-2 text-[11.5px] text-faint"><span><Kbd>↑</Kbd> <Kbd>↓</Kbd> navigate</span><span><Kbd>↵</Kbd> select</span><span className="ml-auto">{isMac ? '⌘K' : 'Ctrl+K'} toggles</span></div>
        </Command>
      </div>
    </div>,
    document.body,
  )
}
