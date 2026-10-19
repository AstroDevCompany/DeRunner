import { beforeEach, describe, expect, it } from 'vitest'
import { data } from '@/lib/store'
import type { Live, ProcInfo } from '@/lib/types'
import { buildRows, type RowOpts } from './rows'

const proc = (pid: number, ppid: number, name: string, app: string | null = null): ProcInfo => ({ pid, ppid, name, exe: `/bin/${name}`, cmd: [name], user: 'u', start: 1, app, app_path: null })
const live = (pid: number, cpu: number, mem = 1): Live => ({ pid, cpu, mem, dr: 0, dw: 0, nr: 0, nw: 0, thr: 1, st: 1 })
const opts = (o: Partial<RowOpts> = {}): RowOpts => ({
  query: '', sortKey: 'cpu', sortDir: -1, mode: 'list', collapsed: new Set(), expandedApps: new Set(), hotOnly: false,
  scale: { cores: 4, memTotal: 1000, perCore: false, diskRef: 1e9, netRef: 1e9 }, ...o,
})

beforeEach(() => {
  data.procs.clear()
  data.live.clear()
  for (const p of [proc(1, 0, 'init'), proc(2, 1, 'shell'), proc(3, 2, 'worker'), proc(4, 2, 'worker2'), proc(5, 1, 'Chrome', 'Chrome'), proc(6, 5, 'Chrome Helper', 'Chrome')]) data.procs.set(p.pid, p)
  ;[[1, 1], [2, 10], [3, 50], [4, 5], [5, 20], [6, 30]].forEach(([pid, cpu]) => data.live.set(pid, live(pid, cpu)))
})

describe('buildRows', () => {
  it('list sorts by cpu desc', () => {
    expect(buildRows(opts()).map((r) => r.pid)).toEqual([3, 6, 5, 2, 4, 1])
  })
  it('filters by query tokens and prefixes', () => {
    expect(buildRows(opts({ query: 'chrome' })).map((r) => r.pid).sort()).toEqual([5, 6])
    expect(buildRows(opts({ query: 'pid:4' })).map((r) => r.pid)).toEqual([4])
  })
  it('tree nests children under parents and rolls up collapsed totals', () => {
    const rows = buildRows(opts({ mode: 'tree' }))
    expect(rows[0].pid).toBe(1)
    expect(rows.map((r) => r.depth)).toContain(2)
    const collapsed = buildRows(opts({ mode: 'tree', collapsed: new Set([2]) }))
    const shell = collapsed.find((r) => r.pid === 2)!
    expect(shell.agg?.cpu).toBe(10 + 50 + 5)
    expect(collapsed.find((r) => r.pid === 3)).toBeUndefined()
  })
  it('tree search keeps ancestors of matches', () => {
    const pids = buildRows(opts({ mode: 'tree', query: 'worker2' })).map((r) => r.pid)
    expect(pids).toEqual([1, 2, 4])
  })
  it('apps mode groups helpers and sums usage', () => {
    const rows = buildRows(opts({ mode: 'apps' }))
    const g = rows.find((r) => r.kind === 'group')!
    expect(g.label).toBe('Chrome')
    expect(g.agg?.cpu).toBe(50)
    expect(g.count).toBe(2)
    expect(rows.some((r) => r.pid === 6)).toBe(false) // collapsed by default
  })
  it('hot only keeps processes at or above 70% of the machine', () => {
    data.live.set(3, live(3, 300)) // 300 / 4 cores = 75%
    expect(buildRows(opts({ hotOnly: true })).map((r) => r.pid)).toEqual([3])
  })
  it('frozen order keeps rows in place while values change, and appends new processes last', () => {
    const before = buildRows(opts())
    const frozen = new Map(before.map((r, i) => [r.key, i]))
    // Values reshuffle completely...
    ;[[1, 90], [2, 1], [3, 2], [4, 70], [5, 3], [6, 4]].forEach(([pid, cpu]) => data.live.set(pid, live(pid, cpu)))
    expect(buildRows(opts({ frozen })).map((r) => r.pid)).toEqual(before.map((r) => r.pid))
    // ...a brand-new process shows up at the end instead of jumping to the top.
    data.procs.set(9, proc(9, 1, 'newcomer')); data.live.set(9, live(9, 999))
    const after = buildRows(opts({ frozen })).map((r) => r.pid)
    expect(after.slice(0, -1)).toEqual(before.map((r) => r.pid))
    expect(after[after.length - 1]).toBe(9)
  })
  it('frozen order keeps tree siblings stable', () => {
    const before = buildRows(opts({ mode: 'tree' }))
    const frozen = new Map(before.map((r, i) => [r.key, i]))
    data.live.set(4, live(4, 500))
    expect(buildRows(opts({ mode: 'tree', frozen })).map((r) => r.pid)).toEqual(before.map((r) => r.pid))
  })
})
