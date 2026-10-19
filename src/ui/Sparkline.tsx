import { memo, useEffect, useRef } from 'react'
import { LEVEL_VAR, type Level } from '@/lib/thresholds'

const cssColor = (v: string, el: HTMLElement) => {
  const m = v.match(/var\((--[\w-]+)\)/)
  return m ? getComputedStyle(el).getPropertyValue(m[1]).trim() || '#10b981' : v
}

/** Tiny canvas sparkline; values are 0..max (default 100). */
export const Sparkline = memo(function Sparkline({ values, level = 'normal', width = 56, height = 18, max = 100 }: { values: number[]; level?: Level; width?: number; height?: number; max?: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = ref.current
    if (!c) return
    const dpr = window.devicePixelRatio || 1
    if (c.width !== width * dpr) {
      c.width = width * dpr
      c.height = height * dpr
    }
    const g = c.getContext('2d')!
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, width, height)
    if (values.length < 2) return
    const col = cssColor(LEVEL_VAR[level], c)
    const top = Math.max(max, 1)
    const step = width / (values.length - 1)
    g.beginPath()
    values.forEach((v, i) => {
      const y = height - 1 - Math.min(1, v / top) * (height - 2)
      i ? g.lineTo(i * step, y) : g.moveTo(0, y)
    })
    g.strokeStyle = col
    g.lineWidth = 1.2
    g.lineJoin = 'round'
    g.stroke()
    g.lineTo(width, height)
    g.lineTo(0, height)
    g.closePath()
    const grad = g.createLinearGradient(0, 0, 0, height)
    grad.addColorStop(0, col + '55')
    grad.addColorStop(1, col + '00')
    g.fillStyle = grad
    g.fill()
  })
  return <canvas ref={ref} style={{ width, height }} className="block" />
})
