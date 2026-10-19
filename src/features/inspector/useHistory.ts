import { useEffect, useRef, useState } from 'react'
import { api } from '@/lib/ipc'
import { data, useApp } from '@/lib/store'
import type { Series } from '@/lib/types'

const empty = (): Series => ({ t: [], cpu: [], mem: [], dr: [], dw: [], nr: [], nw: [] })

/** History for one process: fetched from Rust, then extended live from the snapshot stream. */
export function useHistory(pid: number, tier: 'hi' | 'lo'): Series {
  const [s, setS] = useState<Series>(empty)
  const tick = useApp((x) => x.tick)
  const loaded = useRef(false)

  useEffect(() => {
    loaded.current = false
    setS(empty())
    let alive = true
    const load = () => api.history(pid, tier).then((h) => { if (alive) { setS(h); loaded.current = true } }).catch(() => {})
    load()
    const id = tier === 'lo' ? setInterval(load, 10_000) : undefined
    return () => { alive = false; clearInterval(id) }
  }, [pid, tier])

  useEffect(() => {
    if (tier !== 'hi' || !loaded.current) return
    const l = data.live.get(pid)
    if (!l) return
    const now = Math.floor(Date.now() / 1000)
    setS((h) => {
      if (h.t.length && h.t[h.t.length - 1] >= now) return h
      const keep = h.t.length >= 600 ? 1 : 0
      const push = <T,>(a: T[], v: T) => [...a.slice(keep), v]
      return { t: push(h.t, now), cpu: push(h.cpu, l.cpu), mem: push(h.mem, Math.round(l.mem / 1024)), dr: push(h.dr, l.dr), dw: push(h.dw, l.dw), nr: push(h.nr, l.nr), nw: push(h.nw, l.nw) }
    })
  }, [tick, pid, tier])

  return s
}
