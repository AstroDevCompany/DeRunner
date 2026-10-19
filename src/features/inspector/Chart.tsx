import { useEffect, useRef } from 'react'
import uPlot from 'uplot'

export interface ChartSeries {
  label: string
  color: string // CSS color or var(--x)
  values: number[]
  fill?: boolean
}

export interface Band {
  value: number
  color: string
}

const resolve = (c: string, el: HTMLElement) => {
  const m = c.match(/var\((--[\w-]+)\)/)
  return m ? getComputedStyle(el).getPropertyValue(m[1]).trim() || '#10b981' : c
}

/** Thin uPlot wrapper: themed, auto-resizing, with optional dashed threshold lines. */
export function Chart({ t, series, height = 120, unit = (v: number) => String(Math.round(v)), yMax, bands, time = true }: { t: number[]; series: ChartSeries[]; height?: number; unit?: (v: number) => string; yMax?: number; bands?: Band[]; time?: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  const plot = useRef<uPlot | null>(null)
  const props = useRef({ unit, yMax, bands })
  props.current = { unit, yMax, bands }
  const sig = series.map((s) => s.label + s.color).join('|') + height

  useEffect(() => {
    const el = host.current!
    const fg = resolve('var(--fg-faint)', el)
    const grid = resolve('var(--chart-grid)', el)
    const draw = (u: uPlot) => {
      const b = props.current.bands
      if (!b) return
      const { ctx, bbox } = u
      ctx.save()
      ctx.setLineDash([4, 4])
      ctx.lineWidth = 1
      for (const band of b) {
        const y = u.valToPos(band.value, 'y', true)
        if (y < bbox.top || y > bbox.top + bbox.height) continue
        ctx.strokeStyle = resolve(band.color, el)
        ctx.globalAlpha = 0.55
        ctx.beginPath()
        ctx.moveTo(bbox.left, y)
        ctx.lineTo(bbox.left + bbox.width, y)
        ctx.stroke()
      }
      ctx.restore()
    }
    const opts: uPlot.Options = {
      width: el.clientWidth || 300,
      height,
      padding: [8, 6, 0, 0],
      legend: { show: false },
      cursor: { y: false, drag: { x: false, y: false }, points: { size: 6 } },
      scales: {
        x: { time },
        y: { range: (_u, _min, max) => [0, Math.max(props.current.yMax ?? 0, max * 1.18, 1e-6)] },
      },
      axes: [
        { stroke: fg, grid: { stroke: grid, width: 1 }, ticks: { show: false }, size: 30, font: '10px system-ui', gap: 4 },
        { stroke: fg, grid: { stroke: grid, width: 1 }, ticks: { show: false }, size: 46, font: '10px system-ui', gap: 4, values: (_u, v) => v.map((x) => props.current.unit(x)) },
      ],
      series: [
        {},
        ...series.map((s) => {
          const col = resolve(s.color, el)
          return {
            label: s.label,
            stroke: col,
            width: 1.6,
            points: { show: false },
            fill: s.fill === false ? undefined : (u: uPlot) => {
              const g = u.ctx.createLinearGradient(0, u.bbox.top, 0, u.bbox.top + u.bbox.height)
              g.addColorStop(0, col + '66')
              g.addColorStop(1, col + '05')
              return g
            },
          }
        }),
      ],
      hooks: { draw: [draw] },
    }
    const u = new uPlot(opts, [t, ...series.map((s) => s.values)] as uPlot.AlignedData, el)
    plot.current = u
    const ro = new ResizeObserver(() => u.setSize({ width: el.clientWidth, height }))
    ro.observe(el)
    return () => {
      ro.disconnect()
      u.destroy()
      plot.current = null
    }
  }, [sig]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    plot.current?.setData([t, ...series.map((s) => s.values)] as uPlot.AlignedData)
  })

  return <div ref={host} className="w-full" style={{ height }} />
}
