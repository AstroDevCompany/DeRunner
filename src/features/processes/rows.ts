import { cpuPct, diskPct, memPct, netPct, type Scale } from '@/lib/metrics'
import { data, type SortKey, type ViewMode } from '@/lib/store'
import type { Live, ProcInfo } from '@/lib/types'

export interface Agg {
  cpu: number
  mem: number
  dr: number
  dw: number
  nr: number
  nw: number
  thr: number
}

export interface FlatRow {
  key: string
  kind: 'proc' | 'group'
  pid: number
  depth: number
  hasChildren: boolean
  expanded: boolean
  /** Number of processes represented by `agg` (rolled-up groups / collapsed subtrees). */
  count: number
  agg: Agg | null
  label: string
}

export interface RowOpts {
  query: string
  sortKey: SortKey
  sortDir: 1 | -1
  mode: ViewMode
  collapsed: Set<number>
  expandedApps: Set<string>
  hotOnly: boolean
  scale: Scale
  /** Frozen ordering: row key → rank. Unknown keys (new processes) sort after known ones. */
  frozen?: Map<string, number> | null
}

const hay = new WeakMap<ProcInfo, string>()
function haystack(p: ProcInfo): string {
  let h = hay.get(p)
  if (!h) hay.set(p, (h = `${p.name} ${p.pid} ${p.user ?? ''} ${p.exe ?? ''} ${p.app ?? ''} ${p.cmd.join(' ')}`.toLowerCase()))
  return h
}

function matcher(query: string): ((p: ProcInfo) => boolean) | null {
  const toks = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!toks.length) return null
  return (p) =>
    toks.every((t) => {
      if (t.startsWith('pid:')) return String(p.pid) === t.slice(4)
      if (t.startsWith('user:')) return (p.user ?? '').toLowerCase() === t.slice(5)
      if (t.startsWith('app:')) return (p.app ?? '').toLowerCase().includes(t.slice(4))
      return haystack(p).includes(t)
    })
}

const zero = (): Agg => ({ cpu: 0, mem: 0, dr: 0, dw: 0, nr: 0, nw: 0, thr: 0 })
function addTo(a: Agg, l: Live | Agg) {
  a.cpu += l.cpu; a.mem += l.mem; a.dr += l.dr; a.dw += l.dw; a.nr += l.nr; a.nw += l.nw; a.thr += l.thr
}

function sortVal(key: SortKey, a: Agg | Live | undefined, p: ProcInfo | undefined): number | string {
  switch (key) {
    case 'name': return (p?.name ?? '').toLowerCase()
    case 'user': return (p?.user ?? '').toLowerCase()
    case 'pid': return p?.pid ?? 0
    case 'cpu': return a?.cpu ?? 0
    case 'mem': return a?.mem ?? 0
    case 'disk': return (a?.dr ?? 0) + (a?.dw ?? 0)
    case 'net': return (a?.nr ?? 0) + (a?.nw ?? 0)
    case 'thr': return a?.thr ?? 0
  }
}

function isHot(l: Live | Agg | undefined, s: Scale): boolean {
  if (!l) return false
  return cpuPct(l.cpu, s) >= 70 || memPct(l.mem, s) >= 70 || diskPct(l.dr + l.dw, s) >= 70 || netPct(l.nr + l.nw, s) >= 70
}

export function buildRows(o: RowOpts): FlatRow[] {
  const match = matcher(o.query)
  const frozen = o.frozen ?? null
  // With a frozen order every item sorts by its captured rank (ascending); new items go last, by pid.
  const sv = (key: string, v: number | string, pid: number): [number | string, number] => (frozen ? [frozen.get(key) ?? 1e9, pid] : [v, pid])
  const cmp = (a: [number | string, number], b: [number | string, number]) => {
    if (frozen) return (a[0] as number) - (b[0] as number) || a[1] - b[1]
    const [x, y] = [a[0], b[0]]
    const c = typeof x === 'string' ? x.localeCompare(y as string) : (x as number) - (y as number)
    return (c || a[1] - b[1]) * (typeof x === 'string' && o.sortKey !== 'name' && o.sortKey !== 'user' ? 1 : o.sortDir)
  }
  const procs = data.procs
  const pass = (p: ProcInfo) => (!match || match(p)) && (!o.hotOnly || isHot(data.live.get(p.pid), o.scale))

  if (o.mode === 'list') {
    const items: [number | string, number][] = []
    for (const p of procs.values()) if (pass(p)) items.push(sv(`p${p.pid}`, sortVal(o.sortKey, data.live.get(p.pid), p), p.pid))
    items.sort(cmp)
    return items.map(([, pid]) => ({ key: `p${pid}`, kind: 'proc', pid, depth: 0, hasChildren: false, expanded: false, count: 1, agg: null, label: '' }))
  }

  if (o.mode === 'apps') {
    const groups = new Map<string, ProcInfo[]>()
    const singles: ProcInfo[] = []
    for (const p of procs.values()) {
      if (!pass(p)) continue
      if (p.app) (groups.get(p.app) ?? groups.set(p.app, []).get(p.app)!).push(p)
      else singles.push(p)
    }
    type Item = { sort: [number | string, number]; rows: FlatRow[] }
    const items: Item[] = []
    for (const p of singles) items.push({ sort: sv(`p${p.pid}`, sortVal(o.sortKey, data.live.get(p.pid), p), p.pid), rows: [{ key: `p${p.pid}`, kind: 'proc', pid: p.pid, depth: 0, hasChildren: false, expanded: false, count: 1, agg: null, label: '' }] })
    for (const [app, members] of groups) {
      if (members.length === 1) {
        const p = members[0]
        items.push({ sort: sv(`p${p.pid}`, sortVal(o.sortKey, data.live.get(p.pid), p), p.pid), rows: [{ key: `p${p.pid}`, kind: 'proc', pid: p.pid, depth: 0, hasChildren: false, expanded: false, count: 1, agg: null, label: '' }] })
        continue
      }
      const agg = zero()
      for (const m of members) { const l = data.live.get(m.pid); if (l) addTo(agg, l) }
      const main = members.reduce((a, b) => (a.pid < b.pid ? a : b))
      const expanded = o.expandedApps.has(app) || (!!match && members.length > 0 && o.query.length > 0)
      const rows: FlatRow[] = [{ key: `g${app}`, kind: 'group', pid: main.pid, depth: 0, hasChildren: true, expanded, count: members.length, agg, label: app }]
      if (expanded) {
        const kids: [number | string, number][] = members.map((m) => sv(`p${m.pid}`, sortVal(o.sortKey, data.live.get(m.pid), m), m.pid))
        kids.sort(cmp)
        for (const [, pid] of kids) rows.push({ key: `p${pid}`, kind: 'proc', pid, depth: 1, hasChildren: false, expanded: false, count: 1, agg: null, label: '' })
      }
      items.push({ sort: sv(`g${app}`, sortVal(o.sortKey, agg, main), main.pid), rows })
    }
    items.sort((a, b) => cmp(a.sort, b.sort))
    return items.flatMap((i) => i.rows)
  }

  // tree
  const kids = new Map<number, number[]>()
  const roots: number[] = []
  for (const p of procs.values()) {
    if (p.ppid !== p.pid && procs.has(p.ppid)) (kids.get(p.ppid) ?? kids.set(p.ppid, []).get(p.ppid)!).push(p.pid)
    else roots.push(p.pid)
  }
  const subtree = new Map<number, { agg: Agg; count: number }>()
  const visit = (pid: number): { agg: Agg; count: number } => {
    const hit = subtree.get(pid)
    if (hit) return hit
    const agg = zero()
    const l = data.live.get(pid)
    if (l) addTo(agg, l)
    let count = 1
    for (const c of kids.get(pid) ?? []) {
      const s = visit(c)
      addTo(agg, s.agg)
      count += s.count
    }
    const r = { agg, count }
    subtree.set(pid, r)
    return r
  }
  // Which nodes survive the filter: matches plus their ancestors.
  let keep: Set<number> | null = null
  const forceOpen = new Set<number>()
  if (match || o.hotOnly) {
    keep = new Set()
    for (const p of procs.values()) {
      if (!pass(p)) continue
      let cur: number | undefined = p.pid
      let first = true
      while (cur !== undefined && !keep.has(cur)) {
        keep.add(cur)
        if (!first) forceOpen.add(cur)
        first = false
        const par: ProcInfo | undefined = procs.get(cur)
        cur = par && par.ppid !== par.pid && procs.has(par.ppid) ? par.ppid : undefined
      }
      // ancestors already kept still need to be forced open
      let a = procs.get(p.pid)?.ppid
      while (a !== undefined && procs.has(a)) { forceOpen.add(a); const pp: ProcInfo = procs.get(a)!; if (pp.ppid === a) break; a = pp.ppid }
    }
  }
  const out: FlatRow[] = []
  const walk = (pid: number, depth: number) => {
    if (keep && !keep.has(pid)) return
    const p = procs.get(pid)
    const children = (kids.get(pid) ?? []).filter((c) => !keep || keep.has(c))
    const open = !o.collapsed.has(pid) || forceOpen.has(pid)
    const sub = children.length ? visit(pid) : null
    out.push({ key: `p${pid}`, kind: 'proc', pid, depth, hasChildren: children.length > 0, expanded: open, count: sub?.count ?? 1, agg: children.length && !open ? sub!.agg : null, label: p?.name ?? '' })
    if (!open) return
    const order: [number | string, number][] = children.map((c) => sv(`p${c}`, sortVal(o.sortKey, visit(c).agg, procs.get(c)), c))
    order.sort(cmp)
    for (const [, c] of order) walk(c, depth + 1)
  }
  const rootOrder: [number | string, number][] = roots.map((r) => sv(`p${r}`, sortVal(o.sortKey, visit(r).agg, procs.get(r)), r))
  rootOrder.sort(cmp)
  for (const [, r] of rootOrder) walk(r, 0)
  return out
}

export function avatarHue(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return 120 + (h % 90) // green → cyan, keeps the brand palette
}
