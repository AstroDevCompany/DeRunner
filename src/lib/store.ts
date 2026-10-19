import { create } from 'zustand'
import { api, IpcError, isTauri, onEvent, subscribeSnapshots } from './ipc'
import type { ActiveSession, Anomaly, AppInfo, Live, ProcInfo, Settings, Snapshot, SysStats, UpdateInfo } from './types'

// ------------------------------------------------------------------ live data (mutable, outside React)

export const SPARK_N = 40

export interface Spark {
  buf: Float32Array
  head: number
  n: number
}

export const data = {
  procs: new Map<number, ProcInfo>(),
  live: new Map<number, Live>(),
  sparks: new Map<number, Spark>(),
  sys: null as SysStats | null,
  sysHist: { cpu: new Float32Array(SPARK_N), mem: new Float32Array(SPARK_N), head: 0, n: 0 },
}

function pushSpark(pid: number, v: number) {
  let s = data.sparks.get(pid)
  if (!s) data.sparks.set(pid, (s = { buf: new Float32Array(SPARK_N), head: 0, n: 0 }))
  s.buf[s.head] = v
  s.head = (s.head + 1) % SPARK_N
  if (s.n < SPARK_N) s.n++
}

export function sparkValues(pid: number): number[] {
  const s = data.sparks.get(pid)
  if (!s) return []
  const out: number[] = []
  for (let i = 0; i < s.n; i++) out.push(s.buf[(s.head - s.n + i + SPARK_N * 2) % SPARK_N])
  return out
}

// ------------------------------------------------------------------ UI state

export type View = 'processes' | 'ports' | 'sessions' | 'anomalies' | 'rules' | 'assistant' | 'settings'
export type SettingsTab = 'general' | 'appearance' | 'monitoring' | 'ai' | 'updates' | 'about'
export type ViewMode = 'list' | 'tree' | 'apps'
export type SortKey = 'name' | 'cpu' | 'mem' | 'disk' | 'net' | 'thr' | 'pid' | 'user'
export type InspectorTab = 'overview' | 'resources' | 'network' | 'environment' | 'security'

export interface Toast {
  id: number
  kind: 'info' | 'success' | 'error'
  text: string
}

export interface ConfirmReq {
  title: string
  body: string
  confirmLabel: string
  danger?: boolean
  resolve: (ok: boolean) => void
}

export interface MenuItemDef {
  label?: string
  icon?: string
  danger?: boolean
  disabled?: boolean
  checked?: boolean
  separator?: boolean
  hint?: string
  onSelect?: () => void
  submenu?: MenuItemDef[]
}

interface AppState {
  ready: boolean
  info: AppInfo | null
  settings: Settings | null
  netSupported: boolean
  paused: boolean
  tick: number

  view: View
  settingsTab: SettingsTab
  viewMode: ViewMode
  sortKey: SortKey
  sortDir: 1 | -1
  query: string
  /** When true, row order is frozen (values keep updating). */
  lockOrder: boolean
  /** Row key → position captured when the lock was engaged (null = capture on next render). */
  frozenRank: Map<string, number> | null
  selected: number | null
  multi: Set<number>
  collapsed: Set<number>
  expandedApps: Set<string>
  inspectorTab: InspectorTab

  paletteOpen: boolean
  assistantPid: number | null
  trackTargets: number[] | null
  openSessionId: number | null
  confirmReq: ConfirmReq | null
  menu: { x: number; y: number; items: MenuItemDef[] } | null
  toasts: Toast[]

  activeSessions: ActiveSession[]
  anomalies: Anomaly[]
  update: UpdateInfo | null

  setView: (v: View, tab?: SettingsTab) => void
  set: (p: Partial<AppState>) => void
}

const ls = {
  get<T>(k: string, d: T): T {
    try {
      const v = localStorage.getItem('derunner.' + k)
      return v == null ? d : (JSON.parse(v) as T)
    } catch {
      return d
    }
  },
  put(k: string, v: unknown) {
    try {
      localStorage.setItem('derunner.' + k, JSON.stringify(v))
    } catch {
      /* storage unavailable */
    }
  },
}
export { ls }

export const useApp = create<AppState>((set) => ({
  ready: false,
  info: null,
  settings: null,
  netSupported: false,
  paused: false,
  tick: 0,

  view: 'processes',
  settingsTab: 'general',
  viewMode: ls.get<ViewMode>('viewMode', 'list'),
  sortKey: ls.get<SortKey>('sortKey', 'cpu'),
  sortDir: ls.get<1 | -1>('sortDir', -1),
  query: '',
  lockOrder: ls.get<boolean>('lockOrder', false),
  frozenRank: null,
  selected: null,
  multi: new Set(),
  collapsed: new Set(),
  expandedApps: new Set(),
  inspectorTab: 'overview',

  paletteOpen: false,
  assistantPid: null,
  trackTargets: null,
  openSessionId: null,
  confirmReq: null,
  menu: null,
  toasts: [],

  activeSessions: [],
  anomalies: [],
  update: null,

  setView: (view, tab) => set((s) => ({ view, settingsTab: tab ?? s.settingsTab })),
  set: (p) => set(p),
}))

// ------------------------------------------------------------------ helpers

let toastId = 1
export function toast(kind: Toast['kind'], text: string, ms = 4200) {
  const id = toastId++
  useApp.setState((s) => ({ toasts: [...s.toasts.slice(-4), { id, kind, text }] }))
  setTimeout(() => useApp.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), ms)
}

export function errText(e: unknown): string {
  return e instanceof IpcError ? e.message : e instanceof Error ? e.message : String(e)
}

/** Runs an IPC action, surfacing success/failure as toasts. */
export async function act<T>(fn: () => Promise<T>, okMsg?: string): Promise<T | undefined> {
  try {
    const r = await fn()
    if (okMsg) toast('success', okMsg)
    return r
  } catch (e) {
    toast('error', errText(e))
    return undefined
  }
}

export function confirmDialog(req: Omit<ConfirmReq, 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => useApp.setState({ confirmReq: { ...req, resolve } }))
}

export function showMenu(e: { clientX: number; clientY: number; preventDefault: () => void }, items: MenuItemDef[]) {
  e.preventDefault()
  useApp.setState({ menu: { x: e.clientX, y: e.clientY, items } })
}

// ------------------------------------------------------------------ settings

let saveTimer: ReturnType<typeof setTimeout> | undefined
export function updateSettings(patch: Partial<Settings> | ((s: Settings) => Settings)) {
  const cur = useApp.getState().settings
  if (!cur) return
  const next = typeof patch === 'function' ? patch(cur) : { ...cur, ...patch }
  useApp.setState({ settings: next })
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    api.setSettings(next).catch((e) => toast('error', errText(e)))
  }, 250)
}

// ------------------------------------------------------------------ snapshot ingestion

let tickCount = 0
export function applySnapshot(s: Snapshot) {
  if (s.full) {
    data.procs.clear()
    data.live.clear()
    data.sparks.clear()
  }
  for (const p of s.added) data.procs.set(p.pid, p)
  for (const pid of s.removed) {
    data.procs.delete(pid)
    data.live.delete(pid)
    data.sparks.delete(pid)
  }
  const cores = Math.max(1, s.sys.cores)
  for (const r of s.rows) {
    const pid = r[0]
    let l = data.live.get(pid)
    if (!l) data.live.set(pid, (l = { pid, cpu: 0, mem: 0, dr: 0, dw: 0, nr: 0, nw: 0, thr: 0, st: 0 }))
    l.cpu = r[1]; l.mem = r[2]; l.dr = r[3]; l.dw = r[4]; l.nr = r[5]; l.nw = r[6]; l.thr = r[7]; l.st = r[8]
    pushSpark(pid, r[1] / cores)
  }
  data.sys = s.sys
  const h = data.sysHist
  h.cpu[h.head] = s.sys.cpu
  h.mem[h.head] = s.sys.mem_total ? (s.sys.mem_used / s.sys.mem_total) * 100 : 0
  h.head = (h.head + 1) % SPARK_N
  if (h.n < SPARK_N) h.n++
  useApp.setState({ tick: ++tickCount, netSupported: s.net_supported })
}

// ------------------------------------------------------------------ bootstrap

let booted = false
export async function boot() {
  if (booted) return
  booted = true
  const [info, settings] = await Promise.all([api.appInfo(), api.getSettings()])
  useApp.setState({ info, settings, netSupported: info.net_supported })

  await onEvent<Anomaly>('anomaly', (a) => {
    useApp.setState((s) => (s.anomalies.some((x) => x.id === a.id) ? s : { anomalies: [a, ...s.anomalies].slice(0, 500) }))
    if (a.severity !== 'info') toast(a.severity === 'critical' ? 'error' : 'info', a.title, 6000)
  })
  await onEvent('sessions-changed', refreshSessions)
  await onEvent<{ id: number; status: string }>('session-finished', (e) => {
    toast('success', e.status === 'stopped' ? 'Tracking stopped. Report ready.' : 'Tracking finished. Report ready.')
  })
  await onEvent<UpdateInfo>('update-available', (u) => useApp.setState({ update: u }))
  await onEvent<boolean>('paused-changed', (p) => useApp.setState({ paused: p }))
  await onEvent('open-palette', () => useApp.setState({ paletteOpen: true }))
  await onEvent<string>('navigate', (to) => {
    const [view, tab] = to.split('/')
    useApp.getState().setView(view as View, tab as SettingsTab | undefined)
  })

  api.anomalies().then((list) => useApp.setState((s) => ({ anomalies: [...s.anomalies, ...list.filter((a) => !s.anomalies.some((x) => x.id === a.id))].sort((a, b) => b.ts - a.ts) }))).catch(() => {})
  refreshSessions()
  await subscribeSnapshots(applySnapshot)
  api.setVisible(!document.hidden).catch(() => {})
  useApp.setState({ ready: true })
  // First paint happens before the native window is revealed (no white flash).
  requestAnimationFrame(() => requestAnimationFrame(() => api.appReady().catch(() => {})))

  document.addEventListener('visibilitychange', () => api.setVisible(!document.hidden).catch(() => {}))
  if (isTauri) {
    // WKWebView does not always flip visibilityState when hidden to tray; the Rust side also tracks it.
    window.addEventListener('focus', () => api.setVisible(true).catch(() => {}))
  }
}

export function refreshSessions() {
  api.activeSessions().then((activeSessions) => useApp.setState({ activeSessions })).catch(() => {})
}
