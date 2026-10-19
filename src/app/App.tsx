import { useEffect } from 'react'
import { api } from '@/lib/ipc'
import { boot, useApp, type View } from '@/lib/store'
import { isTauri } from '@/lib/ipc'
import { ConfirmHost, ContextMenuHost, Icon, Kbd, Logo, ToastHost } from '@/ui'
import { AnomaliesView } from '@/features/anomalies/AnomaliesView'
import { AssistantView } from '@/features/assistant/AssistantView'
import { Inspector } from '@/features/inspector/Inspector'
import { Palette } from '@/features/palette/Palette'
import { PortsView } from '@/features/ports/PortsView'
import { ProcessList } from '@/features/processes/ProcessTable'
import { RulesView } from '@/features/rules/RulesView'
import { SessionsView } from '@/features/sessions/SessionsView'
import { TrackDialog } from '@/features/sessions/TrackDialog'
import { SettingsView } from '@/features/settings/SettingsView'
import { SystemStrip } from './SystemStrip'

const NAV: { id: View; label: string; icon: string; key: string }[] = [
  { id: 'processes', label: 'Processes', icon: 'cpu', key: '1' },
  { id: 'ports', label: 'Ports', icon: 'plug', key: '2' },
  { id: 'sessions', label: 'Tracking', icon: 'record', key: '3' },
  { id: 'anomalies', label: 'Anomalies', icon: 'alert', key: '4' },
  { id: 'rules', label: 'Priority rules', icon: 'sliders', key: '5' },
  { id: 'assistant', label: 'Assistant', icon: 'sparkles', key: '6' },
]

const TITLES: Record<View, string> = {
  processes: 'Processes', ports: 'Ports & connections', sessions: 'Tracking sessions', anomalies: 'Anomalies', rules: 'Priority rules', assistant: 'Assistant', settings: 'Settings',
}

const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)

function useTheme() {
  const theme = useApp((s) => s.settings?.theme ?? 'system')
  const solid = useApp((s) => s.settings?.reduce_transparency ?? false)
  useEffect(() => {
    const root = document.documentElement
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => (root.dataset.theme = theme === 'system' ? (mq.matches ? 'dark' : 'light') : theme)
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [theme])
  useEffect(() => {
    document.documentElement.dataset.solid = String(solid)
  }, [solid])
  useEffect(() => {
    document.documentElement.classList.toggle('native', isTauri)
    const vis = () => (document.documentElement.dataset.hidden = String(document.hidden))
    document.addEventListener('visibilitychange', vis)
    return () => document.removeEventListener('visibilitychange', vis)
  }, [])
}

export function App() {
  useTheme()
  useEffect(() => {
    boot().catch((e) => console.error('boot failed', e))
  }, [])
  const { view, selected, ready } = useApp()

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        useApp.setState((s) => ({ paletteOpen: !s.paletteOpen }))
      } else if (mod && e.key === ',') {
        e.preventDefault()
        useApp.getState().setView('settings')
      } else if (mod && /^[1-6]$/.test(e.key)) {
        e.preventDefault()
        useApp.getState().setView(NAV[+e.key - 1].id)
      }
    }
    window.addEventListener('keydown', h)
    const noCtx = (e: MouseEvent) => !(e.target as HTMLElement).closest('.selectable, input, textarea') && e.preventDefault()
    window.addEventListener('contextmenu', noCtx)
    return () => {
      window.removeEventListener('keydown', h)
      window.removeEventListener('contextmenu', noCtx)
    }
  }, [])

  return (
    <>
      <div className="ambient" aria-hidden><i /><i /><i /></div>
      <div className="relative z-10 flex h-full p-2.5 pr-0">
        <Sidebar />
        <main className="flex min-w-0 flex-1 flex-col pl-2.5 pr-2.5">
          <TopBar />
          {!ready ? (
            <div className="grid flex-1 place-items-center text-faint">Starting…</div>
          ) : view === 'processes' ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <SystemStrip />
              <div className="flex min-h-0 flex-1 gap-2.5">
                <ProcessList />
                {selected != null && <Inspector pid={selected} />}
              </div>
            </div>
          ) : view === 'ports' ? <PortsView />
            : view === 'sessions' ? <SessionsView />
              : view === 'anomalies' ? <AnomaliesView />
                : view === 'rules' ? <RulesView />
                  : view === 'assistant' ? <AssistantView />
                    : <SettingsView />}
        </main>
      </div>
      <Palette />
      <TrackDialog />
      <ConfirmHost />
      <ContextMenuHost />
      <ToastHost />
    </>
  )
}

function Sidebar() {
  const { view, activeSessions, update, anomalies, info, paused } = useApp()
  const unseen = anomalies.filter((a) => !a.dismissed && a.severity !== 'info').length
  return (
    <aside className="glass flex w-[204px] flex-none flex-col rounded-2xl" style={{ paddingTop: info?.os === 'macos' || isMac ? 58 : 12 }} aria-label="Navigation">
      <div className="flex items-center gap-2.5 px-4 pb-4 pt-2" data-tauri-drag-region>
        <Logo size={30} className="drop-shadow-md" />
        <div className="leading-tight" data-tauri-drag-region>
          <div className="text-[15px] font-semibold tracking-tight">DeRunner</div>
          <div className="text-[10.5px] text-faint">Process inspector</div>
        </div>
      </div>
      <nav className="flex flex-1 flex-col gap-0.5 px-2.5">
        {NAV.map((n) => (
          <button key={n.id} className="nav-item" aria-current={view === n.id ? 'page' : undefined} onClick={() => useApp.getState().setView(n.id)}>
            <Icon name={n.icon} size={16} />
            <span className="flex-1">{n.label}</span>
            {n.id === 'anomalies' && unseen > 0 && <span className="grid h-[17px] min-w-[17px] place-items-center rounded-full bg-warn/20 px-1 text-[10.5px] font-semibold text-warn">{unseen}</span>}
            {n.id === 'sessions' && activeSessions.length > 0 && <span className="pulse h-2 w-2 rounded-full bg-crit" title="Tracking in progress" />}
          </button>
        ))}
      </nav>
      <div className="flex flex-col gap-0.5 px-2.5 pb-2.5">
        {update?.available && (
          <button className="mb-1 flex items-center gap-2 rounded-xl bg-accent-soft px-2.5 py-2 text-left text-[12px] text-accent" onClick={() => useApp.getState().setView('settings', 'updates')}>
            <Icon name="download" size={14} /> <span><b className="font-semibold">Update {update.latest}</b><br /><span className="opacity-80">Tap for details</span></span>
          </button>
        )}
        <button className="nav-item" aria-current={view === 'settings' ? 'page' : undefined} onClick={() => useApp.getState().setView('settings')}>
          <Icon name="gear" size={16} />
          <span className="flex-1">Settings</span>
          <Kbd>{isMac ? '⌘,' : 'Ctrl ,'}</Kbd>
        </button>
        {paused && <div className="px-2.5 pt-1 text-[11px] text-warn">Monitoring paused</div>}
      </div>
    </aside>
  )
}

function TopBar() {
  const { view, activeSessions, paused } = useApp()
  return (
    <header className="flex h-[54px] flex-none items-center gap-3 [container-type:inline-size]" data-tauri-drag-region>
      <h1 className="text-[19px] font-semibold tracking-tight" data-tauri-drag-region>{TITLES[view]}</h1>
      {activeSessions.length > 0 && (
        <button className="chip chip-crit !h-6 !px-2.5" onClick={() => useApp.getState().setView('sessions')}>
          <span className="pulse h-1.5 w-1.5 rounded-full bg-current" />Tracking {activeSessions.length}
        </button>
      )}
      <div className="ml-auto flex items-center gap-2">
        {paused && (
          <button className="btn btn-sm" onClick={() => { useApp.setState({ paused: false }); api.setPaused(false) }}><Icon name="play" size={11} />Resume monitoring</button>
        )}
        {/* Same width as one of the four system meters, so its left edge lines up with the Network card. */}
        <button className="btn !h-[30px] !justify-start !gap-2.5 !pl-3 !pr-2 text-dim" style={{ width: 'max(190px, calc((100cqw - 30px) / 4))' }} onClick={() => useApp.setState({ paletteOpen: true })} aria-label="Open command palette">
          <Icon name="search" size={14} />
          <span className="flex-1 truncate text-left">Search or run a command</span>
          <Kbd>{isMac ? '⌘K' : 'Ctrl K'}</Kbd>
        </button>
      </div>
    </header>
  )
}
