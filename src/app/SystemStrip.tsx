import { useMemo } from 'react'
import { fmtBytes, fmtPct, fmtRate } from '@/lib/format'
import { diskPct, netPct, scaleFrom } from '@/lib/metrics'
import { data, useApp } from '@/lib/store'
import { level, LEVEL_VAR } from '@/lib/thresholds'
import { Meter, Sparkline } from '@/ui'

function history(which: 'cpu' | 'mem'): number[] {
  const h = data.sysHist
  const out: number[] = []
  for (let i = 0; i < h.n; i++) out.push(h[which][(h.head - h.n + i + h.cpu.length * 2) % h.cpu.length])
  return out
}

function CoreBars({ cores }: { cores: number[] }) {
  return (
    <div className="flex h-[12px] items-end gap-[2px]" aria-label="Per-core load">
      {cores.map((c, i) => (
        <i key={i} className="block w-[5px] rounded-[1.5px]" style={{ height: `${Math.max(12, Math.min(100, c))}%`, background: LEVEL_VAR[level(c)], opacity: c < 5 ? 0.35 : 0.9 }} />
      ))}
    </div>
  )
}

export function SystemStrip() {
  useApp((s) => s.tick)
  const settings = useApp((s) => s.settings)
  const netSupported = useApp((s) => s.netSupported)
  const sys = data.sys
  const scale = useMemo(() => scaleFrom(settings, sys?.cores ?? 1, sys?.mem_total ?? 1), [settings, sys?.cores, sys?.mem_total])
  if (!sys) return <div className="mb-3 h-[96px]" />
  const memPct = (sys.mem_used / Math.max(1, sys.mem_total)) * 100
  const disk = sys.disk_r + sys.disk_w
  const net = sys.net_rx + sys.net_tx
  return (
    <div className="mb-3 flex gap-2.5">
      <Meter label="CPU" icon="cpu" pct={sys.cpu} value={fmtPct(sys.cpu)} spark={<Sparkline values={history('cpu')} level={level(sys.cpu)} width={64} height={22} />}
        sub={<div className="flex items-center justify-between gap-2"><span>Load {sys.load[0].toFixed(2)} · {sys.cores} cores</span><CoreBars cores={sys.per_core} /></div>} />
      <Meter label="Memory" icon="mem" pct={memPct} value={fmtPct(memPct, 0)} spark={<Sparkline values={history('mem')} level={level(memPct)} width={64} height={22} />}
        sub={`${fmtBytes(sys.mem_used)} of ${fmtBytes(sys.mem_total)}${sys.swap_total ? ` · swap ${fmtBytes(sys.swap_used)}` : ''}`} />
      <Meter label="Disk I/O" icon="disk" pct={diskPct(disk, scale)} value={fmtRate(disk)} sub={`Read ${fmtBytes(sys.disk_r, 0)}/s · Write ${fmtBytes(sys.disk_w, 0)}/s`} />
      <Meter label="Network" icon="net" pct={netPct(net, scale)} value={fmtRate(net)} sub={`↓ ${fmtBytes(sys.net_rx, 0)}/s · ↑ ${fmtBytes(sys.net_tx, 0)}/s${netSupported ? '' : ''}`} />
    </div>
  )
}
