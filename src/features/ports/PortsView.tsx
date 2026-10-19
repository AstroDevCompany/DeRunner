import { useMemo, useState } from 'react'
import { inspect } from '@/lib/actions'
import { useAsync } from '@/lib/hooks'
import { api } from '@/lib/ipc'
import { Button, Chip, Empty, Icon, Spinner } from '@/ui'

export function PortsView() {
  const d = useAsync(() => api.listeners(), [])
  const [q, setQ] = useState('')
  const rows = useMemo(() => (d.data ?? []).filter((c) => !q || `${c.process} ${c.local} ${c.proto} ${c.pid}`.toLowerCase().includes(q.toLowerCase())).sort((a, b) => a.local.localeCompare(b.local, undefined, { numeric: true })), [d.data, q])
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-2.5 flex items-center gap-2">
        <div className="relative max-w-[380px] flex-1"><Icon name="search" size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" /><input className="input !pl-8" placeholder="Filter by process, port, protocol…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter ports" /></div>
        <Button small onClick={d.reload}>{d.loading ? <Spinner size={12} /> : <Icon name="refresh" size={12} />}Refresh</Button>
        <span className="ml-auto max-w-md text-right text-[12px] text-faint">Listening sockets visible to your user. Run DeRunner with elevated privileges to see other users' processes.</span>
      </div>
      <div className="glass min-h-0 flex-1 overflow-auto rounded-2xl p-1.5">
        {d.loading && !d.data ? <div className="p-6"><Spinner /></div> : d.error ? <Empty icon="alert" title="Could not list ports">{d.error}</Empty> : rows.length === 0 ? <Empty icon="plug" title="No listening sockets found" /> : (
          <>
            <div className="thead border-b border-line" style={{ gridTemplateColumns: '1.4fr 70px 1.6fr 100px 80px' }}><span>Process</span><span>Proto</span><span>Address</span><span>State</span><span /></div>
            {rows.map((c, i) => (
              <div key={i} className="trow" style={{ gridTemplateColumns: '1.4fr 70px 1.6fr 100px 80px' }}>
                <span className="flex items-center gap-2 truncate font-medium">{c.process || 'Unknown'} <span className="num text-[11.5px] font-normal text-faint">{c.pid}</span></span>
                <span><Chip>{c.proto}</Chip></span>
                <span className="selectable truncate font-mono text-[12px]">{c.local}</span>
                <span className="text-dim">{c.state}</span>
                <span className="text-right"><Button small onClick={() => inspect(c.pid)}>Inspect</Button></span>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  )
}
