import { Channel, invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type {
  ActiveSession, AiEvent, Anomaly, AppInfo, Conn, Details, OpenFile, ProviderKind, RuleEvent, SampleRow,
  Series, SessionDetail, SessionMeta, SignatureInfo, Snapshot, Settings, UpdateInfo, Priority,
} from './types'

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

export class IpcError extends Error {
  kind: string
  constructor(kind: string, message: string) {
    super(message)
    this.kind = kind
  }
}

function toError(e: unknown): IpcError {
  if (e instanceof IpcError) return e
  if (e && typeof e === 'object' && 'message' in e) {
    const o = e as { kind?: string; message: string }
    return new IpcError(o.kind ?? 'Other', o.message)
  }
  return new IpcError('Other', String(e))
}

type MockModule = typeof import('./mock')
let mockMod: Promise<MockModule> | null = null
const mock = () => (mockMod ??= import('./mock'))

export async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    if (isTauri) return await invoke<T>(cmd, args)
    return (await (await mock()).mockCall(cmd, args ?? {})) as T
  } catch (e) {
    throw toError(e)
  }
}

export async function subscribeSnapshots(cb: (s: Snapshot) => void): Promise<void> {
  if (isTauri) {
    const ch = new Channel<Snapshot>()
    ch.onmessage = cb
    await invoke('subscribe', { channel: ch })
  } else {
    await (await mock()).mockSubscribe(cb)
  }
}

export async function onEvent<T = unknown>(name: string, cb: (payload: T) => void): Promise<() => void> {
  if (isTauri) return listen<T>(name, (e) => cb(e.payload))
  return (await mock()).mockOn(name, cb as (p: unknown) => void)
}

export async function aiChat(
  args: { provider?: string; messages: { role: string; content: string }[]; context: { pid?: number | null; session_id?: number | null } },
  onEvt: (e: AiEvent) => void,
): Promise<number> {
  if (isTauri) {
    const ch = new Channel<AiEvent>()
    ch.onmessage = onEvt
    return invoke<number>('ai_chat', { ...args, onEvent: ch }).catch((e) => {
      throw toError(e)
    })
  }
  return (await mock()).mockAiChat(args.messages, onEvt)
}

export const api = {
  appInfo: () => call<AppInfo>('app_info'),
  appReady: () => call<void>('app_ready'),
  getSettings: () => call<Settings>('get_settings'),
  setSettings: (settings: Settings) => call<void>('set_settings', { settings }),
  getLaunchAtLogin: () => call<boolean>('get_launch_at_login'),
  setLaunchAtLogin: (enabled: boolean) => call<void>('set_launch_at_login', { enabled }),
  quit: () => call<void>('quit_app'),
  hideWindow: () => call<void>('hide_window'),
  openExternal: (url: string) => call<void>('open_external', { url }),
  exportText: (filename: string, content: string) => call<string>('export_text', { filename, content }),
  setVisible: (visible: boolean) => call<void>('set_visible', { visible }),
  setPaused: (paused: boolean) => call<void>('set_paused', { paused }),
  history: (pid: number, tier: 'hi' | 'lo') => call<Series>('get_history', { pid, tier }),
  details: (pid: number, reveal: boolean) => call<Details>('process_details', { pid, reveal }),
  signature: (pid: number) => call<SignatureInfo>('process_signature', { pid }),
  openFiles: (pid: number) => call<OpenFile[]>('process_open_files', { pid }),
  connections: (pid: number) => call<Conn[]>('process_connections', { pid }),
  listeners: () => call<Conn[]>('list_listeners'),
  terminate: (pid: number, start: number | null, force: boolean, tree: boolean, allowProtected = false) =>
    call<number>('terminate_process', { pid, start, force, tree, allowProtected }),
  suspend: (pid: number, start: number | null, allowProtected = false) => call<void>('suspend_process', { pid, start, allowProtected }),
  resume: (pid: number, start: number | null) => call<void>('resume_process', { pid, start }),
  relaunch: (pid: number, start: number | null) => call<number>('relaunch_process', { pid, start }),
  setPriority: (pid: number, start: number | null, level: Priority) => call<void>('set_process_priority', { pid, start, level }),
  focusWindow: (pid: number) => call<void>('focus_process_window', { pid }),
  startSession: (targets: { pid: number; start?: number }[], includeChildren: boolean, limitS: number | null, name?: string) =>
    call<number>('sessions_start', { targets, includeChildren, limitS, name }),
  stopSession: (id: number) => call<void>('sessions_stop', { id }),
  activeSessions: () => call<ActiveSession[]>('sessions_active'),
  sessions: () => call<SessionMeta[]>('sessions_list'),
  session: (id: number) => call<SessionDetail>('session_get', { id }),
  sessionSeries: (id: number, pid: number) => call<SampleRow[]>('session_series', { id, pid }),
  deleteSession: (id: number) => call<void>('session_delete', { id }),
  sessionMarkdown: (id: number) => call<string>('session_markdown', { id }),
  sessionAiReport: (id: number) => call<string>('session_ai_report', { id }),
  anomalies: () => call<Anomaly[]>('anomalies_list'),
  dismissAnomaly: (id: number | null) => call<void>('anomaly_dismiss', { id }),
  rulesLog: () => call<RuleEvent[]>('rules_log'),
  aiStatus: () => call<{ kind: ProviderKind; has_key: boolean }[]>('ai_status'),
  aiSetKey: (kind: string, key: string) => call<void>('ai_set_key', { kind, key }),
  aiClearKey: (kind: string) => call<void>('ai_clear_key', { kind }),
  aiModels: (kind: string, baseUrl?: string) => call<string[]>('ai_models', { kind, baseUrl }),
  aiContextPreview: (context: { pid?: number | null; session_id?: number | null }) => call<string>('ai_context_preview', { context }),
  aiCancel: (id: number) => call<void>('ai_cancel', { id }),
  checkUpdate: () => call<UpdateInfo>('check_update'),
}
