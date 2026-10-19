import { useEffect, useMemo, useState } from 'react'
import { fmtAgo } from '@/lib/format'
import { useAsync } from '@/lib/hooks'
import { api, onEvent } from '@/lib/ipc'
import { confirmDialog, data, updateSettings, useApp } from '@/lib/store'
import { PRIORITIES, type PriorityRule, type RuleEvent } from '@/lib/types'
import { Button, Chip, Dialog, Empty, Icon, IconButton, Toggle } from '@/ui'

function globToRegex(g: string) {
  return new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i')
}
function compile(r: Pick<PriorityRule, 'mode' | 'pattern'>): RegExp | null {
  try { return r.pattern ? (r.mode === 'regex' ? new RegExp(r.pattern, 'i') : globToRegex(r.pattern)) : null } catch { return null }
}
const targetOf = (r: Pick<PriorityRule, 'target'>, p: { name: string; exe: string | null; cmd: string[] }) => (r.target === 'path' ? p.exe ?? '' : r.target === 'cmd' ? p.cmd.join(' ') : p.name)

const blank = (): PriorityRule => ({ id: crypto.randomUUID(), name: '', target: 'name', mode: 'glob', pattern: '', priority: 'low', enabled: true })

export function RulesView() {
  const rules = useApp((s) => s.settings?.rules ?? [])
  const caps = useApp((s) => s.info?.capabilities)
  const [edit, setEdit] = useState<PriorityRule | null>(null)
  const log = useAsync(() => api.rulesLog(), [])
  const [live, setLive] = useState<RuleEvent[]>([])
  useEffect(() => {
    let off: (() => void) | undefined
    onEvent<RuleEvent>('rule-applied', (e) => setLive((l) => [e, ...l].slice(0, 100))).then((f) => (off = f))
    return () => off?.()
  }, [])
  const events = [...live, ...(log.data ?? []).filter((e) => !live.some((l) => l.ts === e.ts && l.pid === e.pid))].slice(0, 60)
  const save = (r: PriorityRule) => {
    updateSettings((s) => ({ ...s, rules: s.rules.some((x) => x.id === r.id) ? s.rules.map((x) => (x.id === r.id ? r : x)) : [...s.rules, r] }))
    setEdit(null)
  }
  const move = (i: number, d: number) => updateSettings((s) => { const a = [...s.rules]; const j = i + d; if (j < 0 || j >= a.length) return s; [a[i], a[j]] = [a[j], a[i]]; return { ...s, rules: a } })

  return (
    <div className="flex min-h-0 flex-1 gap-2.5">
      <section className="glass flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl">
        <div className="flex items-center gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="font-semibold">Persistent priority rules</div>
            <div className="text-[12px] text-faint">Matching processes get their priority applied when they launch, and are re-checked every 30 s. The first matching rule wins. Works while DeRunner is in the tray.</div>
          </div>
          <Button variant="primary" onClick={() => setEdit(blank())} disabled={caps?.priority === false}><Icon name="plus" size={13} />Add rule</Button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-2">
          {rules.length === 0 ? <Empty icon="sliders" title="No rules yet">For example: keep <code>mds*</code> at Low so Spotlight indexing never slows your work, or run a render tool at Above normal.</Empty> : rules.map((r, i) => {
            const re = compile(r)
            const matches = re ? [...data.procs.values()].filter((p) => re.test(targetOf(r, p))).length : 0
            return (
              <div key={r.id} className="trow !h-auto !grid-cols-[auto_1fr_auto] gap-3 !py-2.5">
                <Toggle checked={r.enabled} onChange={(v) => updateSettings((s) => ({ ...s, rules: s.rules.map((x) => (x.id === r.id ? { ...x, enabled: v } : x)) }))} label={`Enable ${r.name}`} />
                <button className="min-w-0 text-left" onClick={() => setEdit(r)}>
                  <div className="flex items-center gap-2"><span className="truncate font-medium">{r.name || r.pattern}</span><Chip kind="ok">{PRIORITIES.find((p) => p.id === r.priority)?.label}</Chip></div>
                  <div className="truncate font-mono text-[11.5px] text-faint">{r.target} {r.mode === 'regex' ? '~' : '='} {r.pattern} · {matches} running match{matches === 1 ? '' : 'es'}</div>
                </button>
                <div className="flex">
                  <IconButton icon="chevU" label="Move up" size={13} onClick={() => move(i, -1)} disabled={i === 0} />
                  <IconButton icon="chevD" label="Move down" size={13} onClick={() => move(i, 1)} disabled={i === rules.length - 1} />
                  <IconButton icon="trash" label="Delete rule" size={14} onClick={async () => { if (await confirmDialog({ title: 'Delete rule?', body: `“${r.name || r.pattern}” will stop being applied.`, confirmLabel: 'Delete', danger: true })) updateSettings((s) => ({ ...s, rules: s.rules.filter((x) => x.id !== r.id) })) }} />
                </div>
              </div>
            )
          })}
        </div>
      </section>
      <section className="glass flex w-[330px] flex-none flex-col overflow-hidden rounded-2xl">
        <div className="flex items-center justify-between border-b border-line px-4 py-3"><span className="label">Recently applied</span><IconButton icon="refresh" label="Refresh" size={13} onClick={log.reload} /></div>
        <div className="min-h-0 flex-1 overflow-auto p-2">
          {events.length === 0 ? <div className="p-4 text-center text-[12.5px] text-faint">Nothing applied yet this session.</div> : events.map((e, i) => (
            <div key={i} className="rounded-lg px-2.5 py-2 text-[12.5px]">
              <div className="flex items-center gap-1.5">{e.ok ? <Icon name="check" size={13} className="text-ok" /> : <Icon name="alert" size={13} className="text-warn" />}<span className="truncate font-medium">{e.name}</span><span className="num text-faint">{e.pid}</span></div>
              <div className="text-[11.5px] text-faint">{e.ok ? `Set to ${e.priority}` : e.error} · {e.rule_name} · {fmtAgo(e.ts)}</div>
            </div>
          ))}
        </div>
      </section>
      {edit && <RuleDialog rule={edit} onClose={() => setEdit(null)} onSave={save} />}
    </div>
  )
}

function RuleDialog({ rule, onClose, onSave }: { rule: PriorityRule; onClose: () => void; onSave: (r: PriorityRule) => void }) {
  const [r, setR] = useState(rule)
  const re = useMemo(() => compile(r), [r])
  const invalid = r.pattern !== '' && !re
  const matches = useMemo(() => (re ? [...data.procs.values()].filter((p) => re.test(targetOf(r, p))) : []), [re, r.target]) // eslint-disable-line react-hooks/exhaustive-deps
  const set = <K extends keyof PriorityRule>(k: K, v: PriorityRule[K]) => setR((x) => ({ ...x, [k]: v }))
  return (
    <Dialog open onClose={onClose} title={rule.name || rule.pattern ? 'Edit rule' : 'New priority rule'} width={500}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!r.pattern || invalid} onClick={() => onSave({ ...r, name: r.name || r.pattern })}>Save rule</Button></>}>
      <div className="space-y-3.5">
        <div><div className="label mb-1">Name</div><input className="input" value={r.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Keep indexing quiet" /></div>
        <div className="grid grid-cols-2 gap-3">
          <div><div className="label mb-1">Match against</div><select className="input" value={r.target} onChange={(e) => set('target', e.target.value as PriorityRule['target'])}><option value="name">Process name</option><option value="path">Executable path</option><option value="cmd">Command line</option></select></div>
          <div><div className="label mb-1">Pattern type</div><select className="input" value={r.mode} onChange={(e) => set('mode', e.target.value as PriorityRule['mode'])}><option value="glob">Wildcard (* ?)</option><option value="regex">Regular expression</option></select></div>
        </div>
        <div><div className="label mb-1">Pattern</div><input className={`input font-mono ${invalid ? '!border-crit' : ''}`} value={r.pattern} onChange={(e) => set('pattern', e.target.value)} placeholder={r.mode === 'glob' ? 'chrome*' : '^node(\\d+)?$'} spellCheck={false} />{invalid && <div className="mt-1 text-[12px] text-crit">Invalid pattern</div>}</div>
        <div><div className="label mb-1">Priority</div><select className="input" value={r.priority} onChange={(e) => set('priority', e.target.value as PriorityRule['priority'])}>{PRIORITIES.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select>
          <div className="mt-1 text-[12px] text-faint">Raising priority above Normal usually needs administrator rights; failures are shown in the log.</div></div>
        <div className="glass-flat rounded-xl p-3">
          <div className="mb-1 text-[12px] font-semibold text-dim">Matches right now: {matches.length}</div>
          <div className="flex max-h-24 flex-wrap gap-1 overflow-auto">{matches.slice(0, 40).map((p) => <span key={p.pid} className="chip">{p.name} <span className="num opacity-60">{p.pid}</span></span>)}{!matches.length && <span className="text-[12px] text-faint">{r.pattern ? 'No running process matches.' : 'Type a pattern to preview matches.'}</span>}</div>
        </div>
      </div>
    </Dialog>
  )
}
