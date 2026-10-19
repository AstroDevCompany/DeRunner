// Development-only backend used when running in a plain browser (no Tauri). Synthetic but plausible.
import type {
  ActiveSession, AiEvent, Anomaly, Conn, Details, Finding, OpenFile, ProcInfo, Report, Row, SampleRow, Series,
  SessionDetail, SessionMeta, Settings, SignatureInfo, Snapshot, SysStats, TargetReport, UpdateInfo,
} from './types'

const CORES = 10
const MEM_TOTAL = 32 * 1024 ** 3
const listeners = new Map<string, Set<(p: unknown) => void>>()
export function mockOn(name: string, cb: (p: unknown) => void) {
  if (!listeners.has(name)) listeners.set(name, new Set())
  listeners.get(name)!.add(cb)
  return () => listeners.get(name)!.delete(cb)
}
const emit = (name: string, p?: unknown) => listeners.get(name)?.forEach((cb) => cb(p))

// ---------------------------------------------------------------- processes
interface MP extends ProcInfo { base: number; mem: number; growth: number; burst: number; thr: number; st: number; net: number; io: number }
let rnd = 7
const rand = () => ((rnd = (rnd * 16807) % 2147483647) / 2147483647)
const procs = new Map<number, MP>()
let nextPid = 40000

function add(name: string, ppid: number, o: Partial<MP> & { exe?: string; user?: string; cmd?: string[]; app?: string }): MP {
  const pid = o.pid ?? nextPid++
  const exe = o.exe ?? `/usr/bin/${name}`
  const m = exe.match(/^(.*?([^/]+)\.app)\//)
  const p: MP = {
    pid, ppid, name, exe, cmd: o.cmd ?? [exe], user: o.user ?? 'luca', start: Math.floor(Date.now() / 1000) - Math.floor(rand() * 86400 * 3),
    app: o.app ?? (m ? m[2] : null), app_path: m ? m[1] : null,
    base: o.base ?? rand() * 1.5, mem: o.mem ?? (30 + rand() * 300) * 1024 ** 2, growth: o.growth ?? 0, burst: o.burst ?? 0,
    thr: o.thr ?? Math.floor(2 + rand() * 20), st: 1, net: o.net ?? 0, io: o.io ?? 0,
  }
  procs.set(pid, p)
  return p
}

function seed() {
  add('launchd', 0, { pid: 1, user: 'root', base: 0.1, mem: 20e6 })
  add('kernel_task', 0, { pid: 0 + 2, ppid: 0, user: 'root', base: 4, mem: 1.2e9, thr: 600 })
  const wsrv = add('WindowServer', 1, { user: '_windowserver', base: 6, mem: 480e6, exe: '/System/Library/PrivateFrameworks/SkyLight.framework/WindowServer' })
  void wsrv
  for (const n of ['syslogd', 'distnoted', 'cfprefsd', 'mds', 'mds_stores', 'trustd', 'coreaudiod', 'bluetoothd', 'airportd', 'rapportd', 'powerd', 'securityd'])
    add(n, 1, { user: 'root', base: rand() * 1.2, exe: `/usr/libexec/${n}` })
  const finder = add('Finder', 1, { exe: '/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder', base: 0.6, mem: 210e6 })
  void finder
  const chrome = add('Google Chrome', 1, { exe: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', base: 5, mem: 640e6, net: 40e3 })
  for (let i = 0; i < 9; i++)
    add('Google Chrome Helper (Renderer)', chrome.pid, { exe: '/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer)', base: i === 0 ? 410 : rand() * 40, mem: (120 + rand() * 600) * 1024 ** 2, burst: i === 0 ? 0.05 : 0.01, net: rand() * 30e3 })
  add('Google Chrome Helper (GPU)', chrome.pid, { exe: '/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper (GPU).app/Contents/MacOS/Google Chrome Helper (GPU)', base: 9, mem: 380e6 })
  const slack = add('Slack', 1, { exe: '/Applications/Slack.app/Contents/MacOS/Slack', base: 2, mem: 420e6, net: 8e3 })
  for (let i = 0; i < 4; i++) add('Slack Helper (Renderer)', slack.pid, { exe: '/Applications/Slack.app/Contents/Frameworks/Slack Helper (Renderer).app/Contents/MacOS/Slack Helper (Renderer)', base: rand() * 3, mem: (80 + rand() * 200) * 1024 ** 2 })
  const cursor = add('Cursor', 1, { exe: '/Applications/Cursor.app/Contents/MacOS/Cursor', base: 7, mem: 900e6 })
  for (let i = 0; i < 6; i++) add('Cursor Helper (Plugin)', cursor.pid, { exe: '/Applications/Cursor.app/Contents/Frameworks/Cursor Helper (Plugin).app/Contents/MacOS/Cursor Helper (Plugin)', base: rand() * 6, mem: (90 + rand() * 400) * 1024 ** 2 })
  const term = add('Terminal', 1, { exe: '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal', base: 0.5 })
  const zsh = add('zsh', term.pid, { exe: '/bin/zsh', cmd: ['-zsh'], mem: 12e6 })
  add('node', zsh.pid, { exe: '/opt/homebrew/bin/node', cmd: ['node', 'vite', '--port', '1420', '--token', 'abc123secret'], base: 140, mem: 520e6, growth: 2.2e6, thr: 14 })
  add('ffmpeg', zsh.pid, { exe: '/opt/homebrew/bin/ffmpeg', cmd: ['ffmpeg', '-i', 'input.mov', '-c:v', 'libx265', 'out.mp4'], base: 940, mem: 1.4e9, io: 90e6, thr: 22 })
  add('python3', zsh.pid, { exe: '/opt/homebrew/bin/python3', cmd: ['python3', 'train.py'], base: 310, mem: 3.8e9, thr: 9 })
  add('postgres', 1, { exe: '/opt/homebrew/opt/postgresql@16/bin/postgres', user: 'luca', base: 1.2, mem: 180e6, io: 2e6 })
  add('Docker Desktop', 1, { exe: '/Applications/Docker.app/Contents/MacOS/Docker Desktop', base: 6, mem: 1.1e9, net: 20e3 })
  add('Spotify', 1, { exe: '/Applications/Spotify.app/Contents/MacOS/Spotify', base: 3, mem: 380e6, net: 90e3 })
  add('Safari', 1, { exe: '/Applications/Safari.app/Contents/MacOS/Safari', base: 1.4, mem: 320e6 })
  add('DeRunner', 1, { exe: '/Applications/DeRunner.app/Contents/MacOS/DeRunner', base: 0.8, mem: 95e6 })
  add('updater_tmp', 1, { exe: '/private/tmp/updater_tmp/helper', base: 0.2 })
  for (let i = 0; i < 70; i++) add(['mdworker_shared', 'xpcproxy', 'com.apple.WebKit.Networking', 'cloudd', 'photolibraryd', 'sharingd', 'nsurlsessiond'][i % 7], 1, { exe: `/System/Library/Frameworks/x/${i}`, base: rand() * 0.5, mem: (8 + rand() * 90) * 1024 ** 2, user: i % 5 === 0 ? 'root' : 'luca' })
}
seed()

const live = new Map<number, { cpu: number; mem: number; dr: number; dw: number; nr: number; nw: number }>()
function stepProc(p: MP, t: number) {
  const l = live.get(p.pid) ?? { cpu: p.base, mem: p.mem, dr: 0, dw: 0, nr: 0, nw: 0 }
  const wob = 1 + Math.sin(t / 3000 + p.pid) * 0.15
  let target = p.base * wob * (0.8 + rand() * 0.4)
  if (p.burst && rand() < p.burst) target += 120
  l.cpu = Math.min(CORES * 99, Math.max(0, l.cpu * 0.6 + target * 0.4))
  p.mem += p.growth
  l.mem = p.mem * (1 + (rand() - 0.5) * 0.002)
  l.dr = p.io * rand() * 0.6
  l.dw = p.io * rand()
  l.nr = p.net * rand() * 2
  l.nw = p.net * rand() * 0.4
  live.set(p.pid, l)
  return l
}

function makeSnapshot(full: boolean, ts: number): Snapshot {
  const rows: Row[] = []
  let cpu = 0, mem = 0, dr = 0, dw = 0, nr = 0, nw = 0
  for (const p of procs.values()) {
    const l = stepProc(p, ts)
    rows.push([p.pid, l.cpu, l.mem, l.dr, l.dw, l.nr, l.nw, p.thr, p.st])
    cpu += l.cpu; mem += l.mem; dr += l.dr; dw += l.dw; nr += l.nr; nw += l.nw
  }
  const sys: SysStats = {
    cpu: Math.min(100, cpu / CORES), per_core: Array.from({ length: CORES }, () => Math.min(100, (cpu / CORES) * (0.5 + rand()))), cores: CORES,
    mem_used: Math.min(MEM_TOTAL * 0.97, mem * 0.55 + 4e9), mem_total: MEM_TOTAL, swap_used: 1.2e9, swap_total: 4e9, disk_r: dr, disk_w: dw, net_rx: nr, net_tx: nw,
    load: [3.1, 2.7, 2.2], procs: procs.size, uptime: 86400 * 3.4,
  }
  return { ts, sys, full, added: full ? [...procs.values()].map(strip) : [], removed: [], rows, net_supported: true }
}
const strip = (p: MP): ProcInfo => ({ pid: p.pid, ppid: p.ppid, name: p.name, exe: p.exe, cmd: p.cmd, user: p.user, start: p.start, app: p.app, app_path: p.app_path })

let tickTimer: ReturnType<typeof setInterval> | undefined
export async function mockSubscribe(cb: (s: Snapshot) => void) {
  clearInterval(tickTimer)
  cb(makeSnapshot(true, Date.now()))
  tickTimer = setInterval(() => {
    if (!paused) cb(makeSnapshot(false, Date.now()))
    sessionTick()
  }, 1000)
  setTimeout(() => {
    const p = [...procs.values()].find((x) => x.name === 'ffmpeg')!
    pushAnomaly(p, 'cpu_critical', 'critical', `${p.name} has used over 90% CPU for 12s`, 'Sustained very high CPU. Common causes: a busy loop, heavy compile/render/encode, or a stuck task.', 'cpu_pct', 94, 90)
    const q = [...procs.values()].find((x) => x.name === 'node')!
    pushAnomaly(q, 'mem_growth', 'warn', `${q.name} memory keeps growing (+130 MB/min)`, 'Memory rose steadily by ~400 MB over the last few minutes. Could be a leak, or a cache filling.', 'mem_mb_per_min', 130, 10)
    const u = [...procs.values()].find((x) => x.name === 'updater_tmp')!
    pushAnomaly(u, 'odd_location', 'info', 'updater_tmp is running from a temporary or Downloads location', 'Path: /private/tmp/updater_tmp/helper. Installers and updaters often run from here. Not a verdict, just worth a glance.', 'path', 0, 0)
  }, 4000)
}

// ---------------------------------------------------------------- settings
const defaultSettings = (): Settings => ({
  theme: 'system', reduce_transparency: false, refresh_ms: 1000, cpu_mode: 'normalized', per_process_network: true, close_to_tray: true,
  show_in_dock: true, tray_show_cpu: true, global_shortcut: null, notifications: true, background_alerts: false, disk_ref_mb_s: 500,
  net_ref_mbps: 1000, session_retention_days: 30,
  anomaly: { enabled: true, sustained_critical_s: 10, sustained_warn_s: 30, allowlist: [] },
  rules: [{ id: 'r1', name: 'Keep Spotlight quiet', target: 'name', mode: 'glob', pattern: 'mds*', priority: 'low', enabled: true }],
  ai: {
    default_provider: 'ollama',
    providers: {
      ollama: { base_url: 'http://localhost:11434', model: 'llama3.1:8b' }, lmstudio: { base_url: 'http://localhost:1234/v1', model: '' },
      openai: { base_url: 'https://api.openai.com/v1', model: '' }, anthropic: { base_url: 'https://api.anthropic.com', model: 'claude-sonnet-5-5' },
      openrouter: { base_url: 'https://openrouter.ai/api/v1', model: '' },
    },
    redact: true, auto_report: false,
  },
  update: { auto_check: true, last_check: 0 },
})
let settings: Settings = (() => {
  try { return { ...defaultSettings(), ...JSON.parse(localStorage.getItem('derunner.mock.settings') ?? '{}') } } catch { return defaultSettings() }
})()
let paused = false

// ---------------------------------------------------------------- anomalies
const anomalies: Anomaly[] = []
let anomalyId = 1
function pushAnomaly(p: MP, kind: string, severity: Anomaly['severity'], title: string, detail: string, metric: string, value: number, threshold: number) {
  const a: Anomaly = { id: anomalyId++, ts: Date.now(), pid: p.pid, name: p.name, kind, severity, title, detail, metric, value, threshold, dismissed: false }
  anomalies.unshift(a)
  emit('anomaly', a)
}

// ---------------------------------------------------------------- sessions
interface MS { meta: SessionMeta; report: Report | null; ai: string | null; samples: SampleRow[]; end?: number }
const sessions: MS[] = []
let sessionId = 1
const active = (): ActiveSession[] => sessions.filter((s) => s.meta.status === 'running').map((s) => ({
  id: s.meta.id, name: s.meta.name, started_at: s.meta.started_at, ends_at: s.end ?? null, include_children: s.meta.include_children,
  targets: s.meta.targets.map((t) => ({ pid: t.pid, name: t.name, alive: procs.has(t.pid) })),
}))
function sessionTick() {
  const now = Date.now()
  for (const s of sessions) {
    if (s.meta.status !== 'running') continue
    for (const t of s.meta.targets) {
      const l = live.get(t.pid)
      if (l) s.samples.push({ t: now, pid: t.pid, cpu: l.cpu, mem: l.mem, dr: l.dr, dw: l.dw, nr: l.nr, nw: l.nw, thr: procs.get(t.pid)?.thr ?? 1, n: 1 })
    }
    if (s.end && now >= s.end) finish(s, 'completed')
  }
}
const stat = (v: number[]) => {
  const sorted = [...v].sort((a, b) => a - b)
  return { min: sorted[0] ?? 0, avg: v.reduce((a, b) => a + b, 0) / Math.max(1, v.length), p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0, max: sorted[sorted.length - 1] ?? 0, last: v[v.length - 1] ?? 0, peak_at_s: 0, slope_per_min: 0, over_70_s: v.filter((x) => x >= 70).length, over_90_s: v.filter((x) => x > 90).length }
}
function finish(s: MS, status: SessionMeta['status']) {
  s.meta.status = status
  s.meta.ended_at = Date.now()
  const targets: TargetReport[] = s.meta.targets.map((t) => {
    const rows = s.samples.filter((x) => x.pid === t.pid)
    const cpu = rows.map((r) => r.cpu / CORES)
    const memMb = rows.map((r) => r.mem / 1048576)
    const cs = stat(cpu)
    const findings: Finding[] = [{ severity: cs.max > 90 ? 'critical' : 'info', text: `CPU averaged ${cs.avg.toFixed(1)}% of the machine (p95 ${cs.p95.toFixed(1)}%, peak ${cs.max.toFixed(1)}%).` }]
    if ((memMb[memMb.length - 1] ?? 0) - (memMb[0] ?? 0) > 20) findings.push({ severity: 'warn', text: `Memory grew by ${((memMb[memMb.length - 1] ?? 0) - (memMb[0] ?? 0)).toFixed(0)} MB during the session.` })
    return { pid: t.pid, name: t.name, samples: rows.length, duration_s: rows.length, exited: false, cpu: cs, mem_mb: stat(memMb), mem_pct: stat(rows.map((r) => (r.mem / MEM_TOTAL) * 100)), disk_read: stat(rows.map((r) => r.dr / 1048576)), disk_write: stat(rows.map((r) => r.dw / 1048576)), net_rx: stat(rows.map((r) => r.nr / 1024)), net_tx: stat(rows.map((r) => r.nw / 1024)), threads_max: Math.max(1, ...rows.map((r) => r.thr)), procs_max: 1, findings }
  })
  s.report = {
    name: s.meta.name, started_at: s.meta.started_at, ended_at: s.meta.ended_at!, duration_s: (s.meta.ended_at! - s.meta.started_at) / 1000, status, ncpu: CORES, mem_total: MEM_TOTAL, targets,
    events: [{ t: s.meta.started_at, pid: 0, kind: 'session', severity: 'info', message: 'Session started' }, { t: s.meta.ended_at!, pid: 0, kind: 'session', severity: 'info', message: `Session ${status}` }],
    findings: targets.flatMap((t) => t.findings.filter((f) => f.severity !== 'info').map((f) => ({ ...f, text: `${t.name}: ${f.text}` }))),
  }
  if (!s.report.findings.length) s.report.findings.push({ severity: 'info', text: 'No sustained high usage or leak-like growth detected in this session.' })
  s.meta.has_report = true
  emit('session-finished', { id: s.meta.id, status })
  emit('sessions-changed')
}

// ---------------------------------------------------------------- AI
export async function mockAiChat(messages: { role: string; content: string }[], cb: (e: AiEvent) => void): Promise<number> {
  const last = messages[messages.length - 1]?.content ?? ''
  const text = `**Short answer:** based on the live telemetry, \`ffmpeg\` is the main CPU consumer (about 94% of one core group) and \`python3\` holds the most memory.\n\n## What I see\n- \`ffmpeg\` is encoding with libx265. That codec is CPU heavy by design, so sustained high CPU is expected while it runs.\n- \`node\` (vite) memory has been climbing steadily; this can be a dev-server cache or a leak.\n\n## Suggestions\n1. If the encode is not urgent, lower its priority in the inspector so the machine stays responsive.\n2. Start a **5 minute tracking session** on \`node\` to see if memory plateaus.\n\n_You asked:_ ${last.slice(0, 80)}`
  const words = text.split(/(\s+)/)
  let i = 0
  const id = window.setInterval(() => {
    if (i >= words.length) { clearInterval(id); cb({ type: 'done' }); return }
    cb({ type: 'delta', text: words.slice(i, i + 3).join('') })
    i += 3
  }, 28)
  return id
}

// ---------------------------------------------------------------- history
function fakeSeries(pid: number, tier: 'hi' | 'lo'): Series {
  const p = procs.get(pid)
  const n = tier === 'hi' ? 600 : 360
  const step = tier === 'hi' ? 1 : 10
  const now = Math.floor(Date.now() / 1000)
  const s: Series = { t: [], cpu: [], mem: [], dr: [], dw: [], nr: [], nw: [] }
  const l = live.get(pid)
  let cpu = l?.cpu ?? 1
  for (let i = n; i > 0; i--) {
    cpu = Math.max(0, cpu + (rand() - 0.5) * (p?.base ?? 1) * 0.2 + ((p?.base ?? 1) - cpu) * 0.05)
    s.t.push(now - i * step)
    s.cpu.push(cpu)
    s.mem.push(Math.round((((l?.mem ?? 1e8) - (p?.growth ?? 0) * i * step) / 1024) * (1 + (rand() - 0.5) * 0.01)))
    s.dr.push(Math.round((p?.io ?? 0) * rand() * 0.6)); s.dw.push(Math.round((p?.io ?? 0) * rand()))
    s.nr.push(Math.round((p?.net ?? 0) * rand() * 2)); s.nw.push(Math.round((p?.net ?? 0) * rand() * 0.4))
  }
  return s
}

const sig = (p: MP): SignatureInfo =>
  p.exe?.startsWith('/Applications') || p.exe?.startsWith('/System')
    ? { supported: true, signed: true, valid: true, notarized: !p.exe.startsWith('/System'), identifier: `com.example.${p.name.toLowerCase().replace(/\W+/g, '')}`, team_id: p.exe.startsWith('/System') ? null : 'EQHXZ8M8AV', authority: p.exe.startsWith('/System') ? ['Software Signing', 'Apple Code Signing Certification Authority', 'Apple Root CA'] : ['Developer ID Application: Example Inc (EQHXZ8M8AV)', 'Developer ID Certification Authority', 'Apple Root CA'], note: null }
    : { supported: true, signed: false, valid: null, notarized: null, identifier: null, team_id: null, authority: [], note: null }

let updateChecked = false
export async function mockCall(cmd: string, a: Record<string, unknown>): Promise<unknown> {
  const pid = a.pid as number
  switch (cmd) {
    case 'app_info': return { version: '0.1.0', os: 'macos', arch: 'aarch64', hostname: 'dev-mac.local', os_version: 'macOS 15 (mock)', net_supported: true, manifest_url: 'https://raw.githubusercontent.com/AstroDevCompany/MintFlow-Releases/refs/heads/main/derunner.json', capabilities: { os: 'macos', suspend: true, priority: true, focus_window: true, signature: true, open_files: true, connections: true, per_process_network: true, threads: true, per_process_network_note: '' } }
    case 'app_ready': case 'set_visible': case 'hide_window': case 'quit_app': return undefined
    case 'get_settings': return settings
    case 'set_settings': settings = a.settings as Settings; localStorage.setItem('derunner.mock.settings', JSON.stringify(settings)); return undefined
    case 'get_launch_at_login': return false
    case 'set_launch_at_login': return undefined
    case 'set_paused': paused = a.paused as boolean; return undefined
    case 'get_history': return fakeSeries(pid, a.tier as 'hi' | 'lo')
    case 'process_details': {
      const p = procs.get(pid); if (!p) throw { kind: 'NotFound', message: 'That process is no longer running.' }
      const parents = []; let c = p.ppid
      while (c > 0 && parents.length < 8) { const q = procs.get(c); if (!q) break; parents.push({ pid: q.pid, name: q.name }); c = q.ppid }
      const d: Details = { pid, ppid: p.ppid, name: p.name, exe: p.exe, cwd: '/Users/luca/Desktop/Dev', cmd: p.cmd.map((x) => (a.reveal ? x : x.replace('abc123secret', '••••••'))), env: [['HOME', '/Users/luca'], ['PATH', '/opt/homebrew/bin:/usr/bin:/bin'], ['SHELL', '/bin/zsh'], ['GITHUB_TOKEN', a.reveal ? 'ghp_exampletoken' : '••••••'], ['LANG', 'en_US.UTF-8']], user: p.user, start: p.start, app: p.app, app_path: p.app_path, priority: { level: 'normal', raw: '0' }, parents, children: [...procs.values()].filter((x) => x.ppid === pid).slice(0, 30).map((x) => ({ pid: x.pid, name: x.name })), protected: ['kernel_task', 'launchd', 'WindowServer'].includes(p.name), redacted: !a.reveal }
      return d
    }
    case 'process_signature': { const p = procs.get(pid); await sleep(300); return p ? sig(p) : { supported: true, signed: false, valid: null, notarized: null, identifier: null, team_id: null, authority: [], note: null } }
    case 'process_open_files': { await sleep(200); return ['/dev/null', '/Users/luca/Library/Caches/app.db', '/private/var/log/system.log', 'pipe', '/dev/ttys003'].map((n, i): OpenFile => ({ fd: String(i), kind: i === 3 ? 'PIPE' : 'REG', name: n })) }
    case 'process_connections': { const p = procs.get(pid); return p && p.net ? ([{ pid, process: p.name, proto: 'TCP', local: '192.168.1.20:52114', remote: '142.250.74.35:443', state: 'ESTABLISHED' }, { pid, process: p.name, proto: 'TCP', local: '192.168.1.20:52118', remote: '151.101.1.69:443', state: 'ESTABLISHED' }] as Conn[]) : [] }
    case 'list_listeners': return [
      { pid: 41231, process: 'node', proto: 'TCP', local: '*:1420', remote: '', state: 'LISTEN' }, { pid: 40110, process: 'postgres', proto: 'TCP', local: '127.0.0.1:5432', remote: '', state: 'LISTEN' },
      { pid: 40130, process: 'Docker Desktop', proto: 'TCP', local: '*:2375', remote: '', state: 'LISTEN' }, { pid: 40044, process: 'rapportd', proto: 'TCP', local: '*:49152', remote: '', state: 'LISTEN' }, { pid: 40044, process: 'rapportd', proto: 'UDP', local: '*:5353', remote: '', state: '' },
    ] as Conn[]
    case 'terminate_process': { const p = procs.get(pid); if (p && ['kernel_task', 'launchd', 'WindowServer'].includes(p.name) && !a.allowProtected) throw { kind: 'Protected', message: `${p.name} is a critical system process.` }; procs.delete(pid); return 1 }
    case 'suspend_process': { const p = procs.get(pid); if (p) p.st = 2; return undefined }
    case 'resume_process': { const p = procs.get(pid); if (p) p.st = 1; return undefined }
    case 'relaunch_process': return pid
    case 'set_process_priority': case 'focus_process_window': return undefined
    case 'sessions_start': {
      const targets = (a.targets as { pid: number }[]).map((t) => ({ pid: t.pid, name: procs.get(t.pid)?.name ?? '?', start: 0 }))
      const limit = a.limitS as number | null
      const s: MS = { meta: { id: sessionId++, name: (a.name as string) || targets[0].name, started_at: Date.now(), ended_at: null, limit_s: limit, status: 'running', include_children: a.includeChildren as boolean, targets, has_report: false, has_ai: false }, report: null, ai: null, samples: [], end: limit ? Date.now() + limit * 1000 : undefined }
      sessions.unshift(s); emit('sessions-changed'); return s.meta.id
    }
    case 'sessions_stop': { const s = sessions.find((x) => x.meta.id === a.id); if (s) finish(s, 'stopped'); return undefined }
    case 'sessions_active': return active()
    case 'sessions_list': return sessions.map((s) => s.meta)
    case 'session_get': { const s = sessions.find((x) => x.meta.id === a.id)!; const d: SessionDetail = { meta: s.meta, report: s.report, ai_report: s.ai, ai_error: null, events: s.report?.events ?? [] }; return d }
    case 'session_series': return sessions.find((x) => x.meta.id === a.id)?.samples.filter((x) => x.pid === pid) ?? []
    case 'session_delete': { const i = sessions.findIndex((x) => x.meta.id === a.id); if (i >= 0) sessions.splice(i, 1); emit('sessions-changed'); return undefined }
    case 'session_markdown': return `# DeRunner tracking report\n\n(mock)`
    case 'session_ai_report': { await sleep(900); const s = sessions.find((x) => x.meta.id === a.id)!; s.ai = '## Summary\nThe process behaved normally for the duration of the session.\n\n## Recommendations\n- No action needed.'; s.meta.has_ai = true; emit('session-report-updated', a.id); return s.ai }
    case 'anomalies_list': return anomalies
    case 'anomaly_dismiss': for (const x of anomalies) if (a.id == null || x.id === a.id) x.dismissed = true; return undefined
    case 'rules_log': return []
    case 'ai_status': return ['ollama', 'lmstudio', 'openai', 'anthropic', 'openrouter'].map((kind) => ({ kind, has_key: kind === 'anthropic' }))
    case 'ai_set_key': case 'ai_clear_key': case 'ai_cancel': return undefined
    case 'ai_models': await sleep(400); return a.kind === 'ollama' ? ['llama3.1:8b', 'qwen2.5:14b', 'mistral:7b'] : a.kind === 'anthropic' ? ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'] : ['gpt-5-mini', 'gpt-5']
    case 'ai_context_preview': return '## Machine\n- CPU 38% over 10 logical cores\n- Memory 21 GB / 32 GB used\n\n## Top CPU\n- ffmpeg (pid 40010): 94.0% of machine\n'
    case 'check_update': { await sleep(600); updateChecked = true; const u: UpdateInfo = { current: '0.1.0', latest: '0.2.0', available: true, download_url: null, platform: 'macos', checked_at: Date.now() }; if (updateChecked) emit('update-available', u); return u }
    case 'open_external': window.open(a.url as string, '_blank'); return undefined
    case 'export_text': return `~/Downloads/${a.filename}`
    default: throw { kind: 'Unsupported', message: `mock: ${cmd}` }
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
