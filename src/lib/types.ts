// Mirrors the Rust models (src-tauri/src/monitor/model.rs and friends).
export interface ProcInfo {
  pid: number
  ppid: number
  name: string
  exe: string | null
  cmd: string[]
  user: string | null
  start: number
  app: string | null
  app_path: string | null
}

/** Mutable live values (updated in place each tick to avoid GC churn). cpu is raw: 100 = one core. */
export interface Live {
  pid: number
  cpu: number
  mem: number
  dr: number
  dw: number
  nr: number
  nw: number
  thr: number
  st: number
}

export type Row = [number, number, number, number, number, number, number, number, number]

export interface SysStats {
  cpu: number
  per_core: number[]
  cores: number
  mem_used: number
  mem_total: number
  swap_used: number
  swap_total: number
  disk_r: number
  disk_w: number
  net_rx: number
  net_tx: number
  load: [number, number, number]
  procs: number
  uptime: number
}

export interface Snapshot {
  ts: number
  sys: SysStats
  full: boolean
  added: ProcInfo[]
  removed: number[]
  rows: Row[]
  net_supported: boolean
}

export const ST = { RUN: 0, SLEEP: 1, STOP: 2, ZOMBIE: 3, IDLE: 4, OTHER: 5 } as const

export type Priority = 'low' | 'below_normal' | 'normal' | 'above_normal' | 'high'
export const PRIORITIES: { id: Priority; label: string }[] = [
  { id: 'low', label: 'Low' },
  { id: 'below_normal', label: 'Below normal' },
  { id: 'normal', label: 'Normal' },
  { id: 'above_normal', label: 'Above normal' },
  { id: 'high', label: 'High' },
]

export interface Capabilities {
  os: string
  suspend: boolean
  priority: boolean
  focus_window: boolean
  signature: boolean
  open_files: boolean
  connections: boolean
  per_process_network: boolean
  threads: boolean
  per_process_network_note: string
}

export interface AppInfo {
  version: string
  os: string
  arch: string
  hostname: string | null
  os_version: string | null
  capabilities: Capabilities
  net_supported: boolean
  manifest_url: string
}

export interface PriorityRule {
  id: string
  name: string
  target: 'name' | 'path' | 'cmd'
  mode: 'glob' | 'regex'
  pattern: string
  priority: Priority
  enabled: boolean
}

export type ProviderKind = 'ollama' | 'lmstudio' | 'openai' | 'anthropic' | 'openrouter'

export interface Settings {
  theme: 'system' | 'light' | 'dark'
  reduce_transparency: boolean
  refresh_ms: number
  cpu_mode: 'normalized' | 'per_core'
  per_process_network: boolean
  close_to_tray: boolean
  show_in_dock: boolean
  tray_show_cpu: boolean
  global_shortcut: string | null
  notifications: boolean
  background_alerts: boolean
  disk_ref_mb_s: number
  net_ref_mbps: number
  session_retention_days: number
  anomaly: { enabled: boolean; sustained_critical_s: number; sustained_warn_s: number; allowlist: string[] }
  rules: PriorityRule[]
  ai: {
    default_provider: ProviderKind
    providers: Record<string, { base_url: string; model: string }>
    redact: boolean
    auto_report: boolean
  }
  update: { auto_check: boolean; last_check: number }
}

export interface Series {
  t: number[]
  cpu: number[]
  mem: number[] // KiB
  dr: number[]
  dw: number[]
  nr: number[]
  nw: number[]
}

export interface Relative {
  pid: number
  name: string
}

export interface Details {
  pid: number
  ppid: number
  name: string
  exe: string | null
  cwd: string | null
  cmd: string[]
  env: [string, string][]
  user: string | null
  start: number
  app: string | null
  app_path: string | null
  priority: { level: Priority | null; raw: string } | null
  parents: Relative[]
  children: Relative[]
  protected: boolean
  redacted: boolean
}

export interface SignatureInfo {
  supported: boolean
  signed: boolean
  valid: boolean | null
  notarized: boolean | null
  identifier: string | null
  team_id: string | null
  authority: string[]
  note: string | null
}

export interface OpenFile {
  fd: string
  kind: string
  name: string
}
export interface Conn {
  pid: number
  process: string
  proto: string
  local: string
  remote: string
  state: string
}

export type Severity = 'info' | 'warn' | 'critical'
export interface Anomaly {
  id: number
  ts: number
  pid: number
  name: string
  kind: string
  severity: Severity
  title: string
  detail: string
  metric: string
  value: number
  threshold: number
  dismissed: boolean
}

export interface RuleEvent {
  ts: number
  rule_id: string
  rule_name: string
  pid: number
  name: string
  priority: string
  ok: boolean
  error: string | null
}

export interface TargetMeta {
  pid: number
  name: string
  start: number
}
export interface SessionMeta {
  id: number
  name: string
  started_at: number
  ended_at: number | null
  limit_s: number | null
  status: 'running' | 'completed' | 'stopped' | 'exited'
  include_children: boolean
  targets: TargetMeta[]
  has_report: boolean
  has_ai: boolean
}
export interface ActiveSession {
  id: number
  name: string
  started_at: number
  ends_at: number | null
  include_children: boolean
  targets: { pid: number; name: string; alive: boolean }[]
}

export interface Stats {
  min: number
  avg: number
  p95: number
  max: number
  last: number
  peak_at_s: number
  slope_per_min: number
  over_70_s: number
  over_90_s: number
}
export interface Finding {
  severity: Severity
  text: string
}
export interface TargetReport {
  pid: number
  name: string
  samples: number
  duration_s: number
  exited: boolean
  cpu: Stats
  mem_mb: Stats
  mem_pct: Stats
  disk_read: Stats
  disk_write: Stats
  net_rx: Stats
  net_tx: Stats
  threads_max: number
  procs_max: number
  findings: Finding[]
}
export interface EventRow {
  t: number
  pid: number
  kind: string
  severity: string
  message: string
}
export interface Report {
  name: string
  started_at: number
  ended_at: number
  duration_s: number
  status: string
  ncpu: number
  mem_total: number
  targets: TargetReport[]
  events: EventRow[]
  findings: Finding[]
}
export interface SessionDetail {
  meta: SessionMeta
  report: Report | null
  ai_report: string | null
  ai_error: string | null
  events: EventRow[]
}
export interface SampleRow {
  t: number
  pid: number
  cpu: number
  mem: number
  dr: number
  dw: number
  nr: number
  nw: number
  thr: number
  n: number
}

export interface UpdateInfo {
  current: string
  latest: string
  available: boolean
  download_url: string | null
  platform: string
  checked_at: number
}

export type AiEvent = { type: 'delta'; text: string } | { type: 'done' } | { type: 'error'; message: string }
