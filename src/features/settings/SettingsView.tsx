import { useEffect, useState } from 'react'
import { fmtAgo } from '@/lib/format'
import { useAsync } from '@/lib/hooks'
import { api } from '@/lib/ipc'
import { act, toast, updateSettings, useApp, type SettingsTab } from '@/lib/store'
import type { ProviderKind, Settings } from '@/lib/types'
import { Button, Chip, Icon, Logo, Row, Segmented, Spinner, Toggle } from '@/ui'

const TABS: { id: SettingsTab; label: string; icon: string }[] = [
  { id: 'general', label: 'General', icon: 'gear' },
  { id: 'appearance', label: 'Appearance', icon: 'eye' },
  { id: 'monitoring', label: 'Monitoring', icon: 'cpu' },
  { id: 'ai', label: 'AI providers', icon: 'sparkles' },
  { id: 'updates', label: 'Updates', icon: 'download' },
  { id: 'about', label: 'About', icon: 'info' },
]

const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)

export function SettingsView() {
  const tab = useApp((s) => s.settingsTab)
  const settings = useApp((s) => s.settings)
  if (!settings) return null
  return (
    <div className="flex min-h-0 flex-1 gap-2.5">
      <nav className="glass flex w-[190px] flex-none flex-col gap-0.5 rounded-2xl p-2" aria-label="Settings sections">
        {TABS.map((t) => (
          <button key={t.id} className="nav-item" aria-current={tab === t.id ? 'page' : undefined} onClick={() => useApp.setState({ settingsTab: t.id })}>
            <Icon name={t.icon} size={15} />{t.label}
          </button>
        ))}
      </nav>
      <div className="glass min-w-0 flex-1 overflow-auto rounded-2xl px-6 py-4">
        <div className="mx-auto max-w-[720px]">
          {tab === 'general' && <General s={settings} />}
          {tab === 'appearance' && <Appearance s={settings} />}
          {tab === 'monitoring' && <Monitoring s={settings} />}
          {tab === 'ai' && <AiSettings s={settings} />}
          {tab === 'updates' && <Updates s={settings} />}
          {tab === 'about' && <About />}
        </div>
      </div>
    </div>
  )
}

const H = ({ children, sub }: { children: React.ReactNode; sub?: string }) => (
  <div className="mb-1 mt-1"><h2 className="text-[17px] font-semibold">{children}</h2>{sub && <p className="mt-0.5 text-[12.5px] text-faint">{sub}</p>}</div>
)

function NumberField({ value, onChange, min, max, suffix, width = 88 }: { value: number; onChange: (n: number) => void; min: number; max: number; suffix?: string; width?: number }) {
  return (
    <div className="flex items-center gap-2">
      <input type="number" className="input num" style={{ width }} min={min} max={max} value={value} onChange={(e) => { const n = +e.target.value; if (isFinite(n)) onChange(Math.min(max, Math.max(min, n))) }} />
      {suffix && <span className="text-dim">{suffix}</span>}
    </div>
  )
}

// ------------------------------------------------------------------ general

function ShortcutField({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  const [rec, setRec] = useState(false)
  useEffect(() => {
    if (!rec) return
    const h = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') return setRec(false)
      if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) return
      const mods = [(e.metaKey || e.ctrlKey) && 'CommandOrControl', e.altKey && 'Alt', e.shiftKey && 'Shift'].filter(Boolean) as string[]
      if (!mods.length) return toast('info', 'Include at least one modifier key (⌘/Ctrl, Alt or Shift).')
      onChange([...mods, e.code].join('+'))
      setRec(false)
    }
    window.addEventListener('keydown', h, true)
    return () => window.removeEventListener('keydown', h, true)
  }, [rec, onChange])
  const pretty = value?.replace('CommandOrControl', isMac ? '⌘' : 'Ctrl').replace('Alt', isMac ? '⌥' : 'Alt').replace('Shift', isMac ? '⇧' : 'Shift').replace(/Key|Digit/g, '').replace(/\+/g, ' ')
  return (
    <div className="flex items-center gap-2">
      <Button small onClick={() => setRec(!rec)}>{rec ? 'Press a shortcut… (Esc cancels)' : value ? pretty : 'Record shortcut'}</Button>
      {value && !rec && <Button small onClick={() => onChange(null)}>Clear</Button>}
    </div>
  )
}

function General({ s }: { s: Settings }) {
  const login = useAsync(() => api.getLaunchAtLogin(), [])
  const info = useApp((x) => x.info)
  return (
    <>
      <H sub="How DeRunner lives on your desktop.">General</H>
      <Row title="Launch at login" desc="Starts hidden in the tray so monitoring and priority rules are always active.">
        <Toggle label="Launch at login" checked={!!login.data} onChange={(v) => act(() => api.setLaunchAtLogin(v)).then(login.reload)} />
      </Row>
      <Row title="Keep running in the tray when the window is closed" desc="Closing the window hides it. Use the tray menu or ⌘Q to quit."><Toggle label="Close to tray" checked={s.close_to_tray} onChange={(v) => updateSettings({ close_to_tray: v })} /></Row>
      {info?.os === 'macos' && <Row title="Show in the Dock" desc="Turn off for a menu-bar-only app."><Toggle label="Show in Dock" checked={s.show_in_dock} onChange={(v) => updateSettings({ show_in_dock: v })} /></Row>}
      <Row title="Show live CPU next to the tray icon" desc="Updates only while monitoring is active."><Toggle label="Tray CPU" checked={s.tray_show_cpu} onChange={(v) => updateSettings({ tray_show_cpu: v })} /></Row>
      <Row title="Global shortcut" desc="Show or hide DeRunner from anywhere."><ShortcutField value={s.global_shortcut} onChange={(v) => updateSettings({ global_shortcut: v })} /></Row>
      <Row title="Notifications for anomalies" desc="Native notifications for warnings and critical findings while the window is hidden."><Toggle label="Notifications" checked={s.notifications} onChange={(v) => updateSettings({ notifications: v })} /></Row>
      <Row title="Keep watching while hidden" desc="Samples every 5 s in the background so alerts still fire. Off = zero background CPU unless you track a process or have priority rules."><Toggle label="Background alerts" checked={s.background_alerts} onChange={(v) => updateSettings({ background_alerts: v })} /></Row>
      <Row title="Keep session history for" desc="Older tracking sessions are deleted automatically."><NumberField value={s.session_retention_days} min={1} max={3650} suffix="days" onChange={(n) => updateSettings({ session_retention_days: n })} /></Row>
    </>
  )
}

function Appearance({ s }: { s: Settings }) {
  return (
    <>
      <H sub="Frosted glass, light or dark.">Appearance</H>
      <Row title="Theme" desc="System follows your OS appearance automatically.">
        <Segmented<Settings['theme']> value={s.theme} onChange={(v) => updateSettings({ theme: v })} label="Theme" options={[{ id: 'system', label: 'System' }, { id: 'light', label: 'Light' }, { id: 'dark', label: 'Dark' }]} />
      </Row>
      <Row title="Reduce transparency" desc="Replaces glass with solid surfaces. Lowest GPU use; also follows your OS accessibility setting."><Toggle label="Reduce transparency" checked={s.reduce_transparency} onChange={(v) => updateSettings({ reduce_transparency: v })} /></Row>
      <div className="mt-5">
        <div className="label mb-2">Usage colours</div>
        <div className="glass-flat flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl p-3 text-[12.5px]">
          <span className="flex items-center gap-2"><i className="h-2.5 w-2.5 rounded-full" style={{ background: 'var(--lvl-normal)' }} />Normal: below 70%</span>
          <span className="flex items-center gap-2"><svg width="11" height="11" viewBox="0 0 24 24" style={{ color: 'var(--lvl-warn)' }}><path d="M12 5 21 20H3z" fill="currentColor" /></svg>High: 70% to 90%</span>
          <span className="flex items-center gap-2"><svg width="11" height="11" viewBox="0 0 24 24" style={{ color: 'var(--lvl-crit)' }}><path d="M8.5 3h7L21 8.5v7L15.5 21h-7L3 15.5v-7z" fill="currentColor" /></svg>Critical: above 90%</span>
        </div>
        <p className="mt-1.5 text-[12px] text-faint">Colour is always paired with a shape and a number, so it stays readable without relying on hue.</p>
      </div>
    </>
  )
}

function Monitoring({ s }: { s: Settings }) {
  const caps = useApp((x) => x.info?.capabilities)
  const netSupported = useApp((x) => x.info?.net_supported)
  const a = s.anomaly
  const setA = (p: Partial<Settings['anomaly']>) => updateSettings({ anomaly: { ...a, ...p } })
  return (
    <>
      <H sub="Sampling and what counts as high usage.">Monitoring</H>
      <Row title="Refresh rate" desc="Faster feels livelier; slower uses less CPU."><Segmented<string> value={String(s.refresh_ms)} onChange={(v) => updateSettings({ refresh_ms: +v })} label="Refresh" options={[{ id: '500', label: '0.5 s' }, { id: '1000', label: '1 s' }, { id: '2000', label: '2 s' }, { id: '5000', label: '5 s' }]} /></Row>
      <Row title="CPU percentage" desc={s.cpu_mode === 'normalized' ? '0–100% of the whole machine. A process using one core of ten shows 10%.' : 'Like Activity Monitor: 100% is one full core, so values can exceed 100%.'}>
        <Segmented<Settings['cpu_mode']> value={s.cpu_mode} onChange={(v) => updateSettings({ cpu_mode: v })} label="CPU mode" options={[{ id: 'normalized', label: 'Whole machine' }, { id: 'per_core', label: 'Per core' }]} />
      </Row>
      <Row title="Per-process network usage" desc={netSupported ? 'Uses the system network accounting tool only while the window or a session needs it.' : caps?.per_process_network_note || 'Not available on this platform; system totals are shown.'}>
        <Toggle label="Per-process network" checked={s.per_process_network && !!netSupported} onChange={(v) => updateSettings({ per_process_network: v })} />
      </Row>
      <Row title="Disk reference throughput" desc="What counts as 100% for disk colouring."><NumberField value={s.disk_ref_mb_s} min={10} max={20000} suffix="MB/s" onChange={(n) => updateSettings({ disk_ref_mb_s: n })} /></Row>
      <Row title="Network link speed" desc="What counts as 100% for network colouring."><NumberField value={s.net_ref_mbps} min={1} max={100000} suffix="Mbit/s" onChange={(n) => updateSettings({ net_ref_mbps: n })} /></Row>

      <div className="mt-6"><H sub="Unusual patterns are flagged for you to review. They are not verdicts.">Anomaly detection</H></div>
      <Row title="Enable anomaly detection"><Toggle label="Anomaly detection" checked={a.enabled} onChange={(v) => setA({ enabled: v })} /></Row>
      <Row title="Critical after" desc="Seconds above 90% before a critical signal."><NumberField value={a.sustained_critical_s} min={3} max={600} suffix="seconds" onChange={(n) => setA({ sustained_critical_s: n })} /></Row>
      <Row title="High after" desc="Seconds at or above 70% before a warning."><NumberField value={a.sustained_warn_s} min={5} max={900} suffix="seconds" onChange={(n) => setA({ sustained_warn_s: n })} /></Row>
      <div className="py-3">
        <div className="mb-1.5 font-medium">Ignored processes</div>
        <div className="flex flex-wrap gap-1.5">
          {a.allowlist.length === 0 && <span className="text-[12.5px] text-faint">None. Use “Always ignore” on an anomaly to add one.</span>}
          {a.allowlist.map((n) => <button key={n} className="chip hover:bg-crit/15 hover:text-crit" onClick={() => setA({ allowlist: a.allowlist.filter((x) => x !== n) })} title="Click to remove">{n}<Icon name="x" size={10} /></button>)}
        </div>
      </div>
    </>
  )
}

// ------------------------------------------------------------------ AI

const PROVIDERS: { id: ProviderKind; name: string; blurb: string; cloud: boolean; keyHint?: string }[] = [
  { id: 'ollama', name: 'Ollama', blurb: 'Local models on this machine.', cloud: false },
  { id: 'lmstudio', name: 'LM Studio', blurb: 'Local OpenAI-compatible server (start it in LM Studio → Developer).', cloud: false },
  { id: 'openai', name: 'OpenAI', blurb: 'GPT models via the OpenAI API.', cloud: true, keyHint: 'sk-…' },
  { id: 'anthropic', name: 'Anthropic', blurb: 'Claude models via the Anthropic API.', cloud: true, keyHint: 'sk-ant-…' },
  { id: 'openrouter', name: 'OpenRouter', blurb: 'Many hosted models through one key.', cloud: true, keyHint: 'sk-or-…' },
]

function AiSettings({ s }: { s: Settings }) {
  const status = useAsync(() => api.aiStatus(), [])
  return (
    <>
      <H sub="Pick the model that powers the assistant and session reports. Keys are stored in your system keychain and never touch the interface layer.">AI providers</H>
      <Row title="Default provider"><select className="input !w-48" value={s.ai.default_provider} onChange={(e) => updateSettings({ ai: { ...s.ai, default_provider: e.target.value as ProviderKind } })} aria-label="Default provider">{PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Row>
      <Row title="Redact sensitive data" desc="Masks secret-looking arguments and swaps your home folder for ~ before anything is sent."><Toggle label="Redact" checked={s.ai.redact} onChange={(v) => updateSettings({ ai: { ...s.ai, redact: v } })} /></Row>
      <Row title="Write an AI analysis after every tracking session" desc="Uses the default provider. Cloud providers receive only aggregate session statistics."><Toggle label="Auto report" checked={s.ai.auto_report} onChange={(v) => updateSettings({ ai: { ...s.ai, auto_report: v } })} /></Row>
      <div className="mt-4 space-y-3">
        {PROVIDERS.map((p) => <ProviderCard key={p.id} p={p} s={s} hasKey={!!status.data?.find((x) => x.kind === p.id)?.has_key} onKey={status.reload} />)}
      </div>
    </>
  )
}

function ProviderCard({ p, s, hasKey, onKey }: { p: (typeof PROVIDERS)[number]; s: Settings; hasKey: boolean; onKey: () => void }) {
  const cfg = s.ai.providers[p.id] ?? { base_url: '', model: '' }
  const [key, setKey] = useState('')
  const [models, setModels] = useState<string[] | null>(null)
  const [state, setState] = useState<{ busy: boolean; msg?: string; ok?: boolean }>({ busy: false })
  const set = (patch: Partial<typeof cfg>) => updateSettings({ ai: { ...s.ai, providers: { ...s.ai.providers, [p.id]: { ...cfg, ...patch } } } })
  const test = async () => {
    setState({ busy: true })
    try {
      const m = await api.aiModels(p.id, cfg.base_url)
      setModels(m)
      setState({ busy: false, ok: true, msg: `Connected. ${m.length} model${m.length === 1 ? '' : 's'} available.` })
      if (!cfg.model && m.length) set({ model: m[0] })
    } catch (e) {
      setState({ busy: false, ok: false, msg: e instanceof Error ? e.message : String(e) })
    }
  }
  const isDefault = s.ai.default_provider === p.id
  return (
    <div className={`glass-flat rounded-2xl p-4 ${isDefault ? '!border-accent/40' : ''}`}>
      <div className="mb-3 flex items-center gap-2">
        <span className="text-[14px] font-semibold">{p.name}</span>
        <Chip kind={p.cloud ? 'warn' : 'ok'}>{p.cloud ? 'Cloud' : 'Local'}</Chip>
        {isDefault && <Chip kind="ok">Default</Chip>}
        <span className="flex-1 truncate text-[12px] text-faint">{p.blurb}</span>
        {!isDefault && <Button small onClick={() => updateSettings({ ai: { ...s.ai, default_provider: p.id } })}>Make default</Button>}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div><div className="label mb-1">Base URL</div><input className="input font-mono !text-[12px]" value={cfg.base_url} onChange={(e) => set({ base_url: e.target.value })} spellCheck={false} /></div>
        <div>
          <div className="label mb-1">Model</div>
          <input className="input font-mono !text-[12px]" list={`models-${p.id}`} value={cfg.model} onChange={(e) => set({ model: e.target.value })} placeholder={models ? 'Choose or type…' : 'Click Test to list models'} spellCheck={false} />
          <datalist id={`models-${p.id}`}>{models?.map((m) => <option key={m} value={m} />)}</datalist>
        </div>
      </div>
      {p.cloud && (
        <div className="mt-3">
          <div className="label mb-1">API key {hasKey && <span className="ml-1 normal-case text-ok">· saved in keychain</span>}</div>
          <div className="flex gap-2">
            <input type="password" className="input font-mono" value={key} onChange={(e) => setKey(e.target.value)} placeholder={hasKey ? '••••••••••••  (enter a new key to replace)' : p.keyHint} autoComplete="off" spellCheck={false} />
            <Button disabled={!key.trim()} onClick={() => act(() => api.aiSetKey(p.id, key), 'API key saved to keychain').then(() => { setKey(''); onKey() })}>Save</Button>
            {hasKey && <Button variant="danger" onClick={() => act(() => api.aiClearKey(p.id), 'API key removed').then(onKey)}>Remove</Button>}
          </div>
        </div>
      )}
      <div className="mt-3 flex items-center gap-3">
        <Button small onClick={test} disabled={state.busy || (p.cloud && !hasKey)}>{state.busy ? <Spinner size={12} /> : <Icon name="bolt" size={12} />}Test connection</Button>
        {state.msg && <span className={`min-w-0 flex-1 truncate text-[12px] ${state.ok ? 'text-ok' : 'text-crit'}`} title={state.msg}>{state.msg}</span>}
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ updates

function Updates({ s }: { s: Settings }) {
  const cached = useApp((x) => x.update)
  const info = useApp((x) => x.info)
  const [busy, setBusy] = useState(false)
  const [res, setRes] = useState(cached)
  const [err, setErr] = useState<string | null>(null)
  const check = async () => {
    setBusy(true); setErr(null)
    try { const u = await api.checkUpdate(); setRes(u); useApp.setState({ update: u.available ? u : null }) } catch (e) { setErr(e instanceof Error ? e.message : String(e)) }
    setBusy(false)
  }
  return (
    <>
      <H sub="DeRunner checks a small public manifest for a newer version.">Updates</H>
      <div className="glass-flat mt-2 flex items-center gap-4 rounded-2xl p-4">
        <Logo size={44} />
        <div className="flex-1"><div className="text-[15px] font-semibold">DeRunner {info?.version}</div><div className="text-[12.5px] text-faint">{res ? `Last checked ${fmtAgo(res.checked_at)}` : s.update.last_check ? `Last checked ${fmtAgo(s.update.last_check)}` : 'Not checked yet'}</div></div>
        <Button variant="primary" onClick={check} disabled={busy}>{busy ? <Spinner size={13} /> : <Icon name="refresh" size={13} />}Check for updates</Button>
      </div>
      {err && <div className="mt-3 rounded-xl bg-crit/10 px-3.5 py-2.5 text-[12.5px] text-crit">Could not check for updates: {err}</div>}
      {res && !err && (res.available ? (
        <div className="mt-3 rounded-2xl bg-accent-soft p-4">
          <div className="flex items-center gap-2"><Icon name="download" size={16} className="text-accent" /><span className="font-semibold">Version {res.latest} is available</span><Chip>you have {res.current}</Chip></div>
          {res.download_url ? <Button className="mt-3" variant="primary" onClick={() => act(() => api.openExternal(res.download_url!))}><Icon name="download" size={13} />Download for {res.platform}</Button>
            : <p className="mt-2 text-[12.5px] text-dim">A new version exists, but no download link for your platform ({res.platform}) has been published yet.</p>}
        </div>
      ) : <div className="mt-3 flex items-center gap-2 rounded-2xl bg-fg/5 px-4 py-3 text-dim"><Icon name="check" size={15} className="text-ok" />You're on the latest version ({res.current}).</div>)}
      <Row title="Check automatically" desc="Once a day, shortly after launch."><Toggle label="Auto check" checked={s.update.auto_check} onChange={(v) => updateSettings({ update: { ...s.update, auto_check: v } })} /></Row>
      <div className="mt-1 text-[11.5px] text-faint">Manifest: <span className="selectable break-all font-mono">{info?.manifest_url}</span></div>
    </>
  )
}

// ------------------------------------------------------------------ about

function Link({ href, children }: { href: string; children: React.ReactNode }) {
  return <button className="text-accent underline-offset-2 hover:underline" onClick={() => act(() => api.openExternal(href))}>{children}</button>
}

function About() {
  const info = useApp((x) => x.info)
  return (
    <div className="flex flex-col items-center pt-6 text-center">
      <Logo size={96} className="drop-shadow-xl" />
      <h2 className="mt-4 text-[26px] font-semibold tracking-tight">DeRunner</h2>
      <p className="text-dim">Process manager &amp; inspector</p>
      <Chip kind="ok">Version {info?.version}</Chip>
      <div className="glass-flat mt-7 w-full max-w-[460px] rounded-2xl p-1 text-left">
        <div className="flex items-center gap-3 px-4 py-3"><span className="grid h-9 w-9 place-items-center rounded-xl bg-accent-soft text-accent"><Icon name="layers" size={17} /></span><div><div className="label">Developer</div><div className="text-[14px] font-semibold">MintFlow Technologies</div><Link href="https://mintflow.dev">mintflow.dev</Link></div></div>
        <div className="mx-4 h-px bg-line" />
        <div className="flex items-center gap-3 px-4 py-3"><span className="grid h-9 w-9 place-items-center rounded-xl bg-accent-soft text-accent"><Icon name="bolt" size={17} /></span><div><div className="label">Lead developer</div><div className="text-[14px] font-semibold">Luca Montanari</div><Link href="https://instagram.com/montanarii.luca">instagram.com/montanarii.luca</Link></div></div>
      </div>
      <div className="mt-6 text-[12px] text-faint">
        {info && <div className="num">{info.os_version ?? info.os} · {info.arch}{info.hostname ? ` · ${info.hostname}` : ''}</div>}
        <div className="mt-1">Built with Tauri, Rust, React and Tailwind.</div>
        <div className="mt-1">© {new Date().getFullYear()} MintFlow Technologies</div>
      </div>
    </div>
  )
}
