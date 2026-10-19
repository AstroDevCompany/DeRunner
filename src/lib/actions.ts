import { api } from './ipc'
import { basename } from './format'
import { act, confirmDialog, data, toast, useApp, type MenuItemDef } from './store'
import { PRIORITIES, ST, type Priority } from './types'

const PROTECTED = new Set(['kernel_task', 'launchd', 'windowserver', 'loginwindow', 'systemd', 'init', 'csrss.exe', 'wininit.exe', 'winlogon.exe', 'services.exe', 'lsass.exe', 'smss.exe', 'system', 'securityd', 'coreservicesd', 'opendirectoryd'])
export const isProtected = (name: string) => PROTECTED.has(name.toLowerCase())

export function procLabel(pid: number): string {
  const p = data.procs.get(pid)
  return p ? `${p.name} (${pid})` : `pid ${pid}`
}

export async function terminateProc(pid: number, opts: { force?: boolean; tree?: boolean } = {}) {
  const p = data.procs.get(pid)
  if (!p) return toast('error', 'That process is no longer running.')
  const prot = isProtected(p.name)
  const kids = [...data.procs.values()].filter((c) => c.ppid === pid).length
  const ok = await confirmDialog({
    title: prot ? `Stop critical process “${p.name}”?` : `${opts.force ? 'Force quit' : 'Terminate'} “${p.name}”?`,
    body: prot
      ? `${p.name} is a core system process. Stopping it can freeze, crash or log you out of this machine. Only continue if you know what you are doing.`
      : opts.tree
        ? `This will ${opts.force ? 'forcefully ' : ''}stop ${p.name} and all ${kids ? 'of its descendants' : 'child processes'}. Unsaved work in them will be lost.`
        : opts.force
          ? 'The process is killed immediately and cannot save or clean up. Unsaved work will be lost.'
          : 'The process is asked to quit (SIGTERM / close request) and can save and clean up. If it ignores the request, use Force quit.',
    confirmLabel: opts.force ? 'Force quit' : 'Terminate',
    danger: true,
  })
  if (!ok) return
  await act(() => api.terminate(pid, p.start, !!opts.force, !!opts.tree, prot), opts.force ? `Force-quit ${p.name}` : `Asked ${p.name} to quit`)
}

export async function suspendProc(pid: number) {
  const p = data.procs.get(pid)
  if (!p) return
  if (isProtected(p.name)) {
    const ok = await confirmDialog({ title: `Suspend “${p.name}”?`, body: 'Suspending a core system process can freeze the system until it is resumed.', confirmLabel: 'Suspend', danger: true })
    if (!ok) return
  }
  await act(() => api.suspend(pid, p.start, isProtected(p.name)), `Suspended ${p.name}`)
}
export async function resumeProc(pid: number) {
  const p = data.procs.get(pid)
  if (p) await act(() => api.resume(pid, p.start), `Resumed ${p.name}`)
}
export async function relaunchProc(pid: number) {
  const p = data.procs.get(pid)
  if (!p) return
  const ok = await confirmDialog({ title: `Relaunch “${p.name}”?`, body: 'The process is stopped, then started again with the same executable, arguments and working directory. Unsaved work in it will be lost.', confirmLabel: 'Relaunch', danger: true })
  if (ok) await act(() => api.relaunch(pid, p.start), `Relaunched ${p.name}`)
}
export async function setPriorityProc(pid: number, level: Priority) {
  const p = data.procs.get(pid)
  if (p) await act(() => api.setPriority(pid, p.start, level), `${p.name} priority set to ${PRIORITIES.find((x) => x.id === level)?.label}`)
}
export const focusProc = (pid: number) => act(() => api.focusWindow(pid))
export const trackProcs = (pids: number[]) => useApp.setState({ trackTargets: pids })
export function askAi(pid: number | null) {
  useApp.setState({ assistantPid: pid, view: 'assistant' })
}
export function inspect(pid: number) {
  useApp.setState({ selected: pid, view: 'processes' })
}
export async function copyText(text: string, what = 'Copied') {
  try {
    await navigator.clipboard.writeText(text)
    toast('success', what)
  } catch {
    toast('error', 'Could not copy to the clipboard')
  }
}

export function buildProcMenu(pid: number): MenuItemDef[] {
  const p = data.procs.get(pid)
  const caps = useApp.getState().info?.capabilities
  const multi = useApp.getState().multi
  const targets = multi.has(pid) && multi.size > 1 ? [...multi] : [pid]
  if (!p) return []
  const stopped = data.live.get(pid)?.st === ST.STOP
  return [
    { label: 'Inspect', icon: 'info', onSelect: () => inspect(pid) },
    { label: targets.length > 1 ? `Track ${targets.length} processes…` : 'Start tracking…', icon: 'record', onSelect: () => trackProcs(targets) },
    { label: 'Ask the assistant', icon: 'sparkles', onSelect: () => askAi(pid) },
    { separator: true },
    ...(caps?.suspend !== false ? [stopped ? { label: 'Resume', icon: 'play', onSelect: () => resumeProc(pid) } : { label: 'Suspend', icon: 'pause', onSelect: () => suspendProc(pid) }] : []),
    { label: 'Terminate', icon: 'kill', danger: true, onSelect: () => terminateProc(pid) },
    { label: 'Force quit', icon: 'kill', danger: true, onSelect: () => terminateProc(pid, { force: true }) },
    { label: 'Terminate process tree', icon: 'tree', danger: true, onSelect: () => terminateProc(pid, { tree: true }) },
    { label: 'Relaunch', icon: 'refresh', onSelect: () => relaunchProc(pid) },
    { separator: true },
    ...(caps?.focus_window ? [{ label: 'Bring window to front', icon: 'window', onSelect: () => focusProc(pid) }] : []),
    ...(caps?.priority ? [{ label: 'Priority', icon: 'sliders', submenu: PRIORITIES.map((pr) => ({ label: pr.label, onSelect: () => setPriorityProc(pid, pr.id) })) }] : []),
    { separator: true },
    { label: 'Copy PID', icon: 'copy', onSelect: () => copyText(String(pid), 'PID copied') },
    ...(p.exe ? [{ label: `Copy path (${basename(p.exe)})`, icon: 'copy', onSelect: () => copyText(p.exe!, 'Path copied') }] : []),
  ]
}
