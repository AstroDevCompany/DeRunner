import type { SVGProps } from 'react'

// Compact 24x24 stroke icon set (rounded, 1.7px).
const P: Record<string, string> = {
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zm9 16-3.8-3.8',
  list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  tree: 'M5 4v6a2 2 0 0 0 2 2h4M5 10v8a2 2 0 0 0 2 2h4M14 9h6v6h-6zM11 15h6',
  apps: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  plug: 'M9 3v5M15 3v5M7 8h10v3a5 5 0 0 1-10 0zM12 16v5',
  clock: 'M12 7v5l3 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z',
  alert: 'M12 4 3 20h18zM12 10v4M12 17.2v.01',
  sliders: 'M4 7h9M17 7h3M4 17h3M11 17h9M13 4v6M7 14v6',
  sparkles: 'M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8zM18.5 15l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z',
  gear: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM19.4 13.5l1.7 1.3-1.8 3.1-2-.7a7 7 0 0 1-1.6.9L15.3 20h-3.6l-.4-1.9a7 7 0 0 1-1.6-.9l-2 .7-1.8-3.1 1.7-1.3a7 7 0 0 1 0-1.8L5.9 10.4l1.8-3.1 2 .7a7 7 0 0 1 1.6-.9L11.7 5h3.6l.4 2.1a7 7 0 0 1 1.6.9l2-.7 1.8 3.1-1.7 1.3a7 7 0 0 1 0 1.8z',
  chevR: 'm9 6 6 6-6 6',
  chevD: 'm6 9 6 6 6-6',
  chevU: 'm6 15 6-6 6 6',
  x: 'M6 6l12 12M18 6 6 18',
  check: 'm5 12.5 4.5 4.5L19 7.5',
  copy: 'M9 9h10v10H9zM5 15V5h10',
  ext: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  play: 'M7 4.5v15l12-7.5z',
  pause: 'M8 5v14M16 5v14',
  stop: 'M6 6h12v12H6z',
  record: 'M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10z',
  refresh: 'M20 11a8 8 0 0 0-14.5-3.5L4 9M4 4v5h5M4 13a8 8 0 0 0 14.5 3.5L20 15M20 20v-5h-5',
  kill: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9 9l6 6M15 9l-6 6',
  shield: 'M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6zM9 12l2 2 4-4',
  window: 'M4 5h16v14H4zM4 9h16',
  cmd: 'M9 9v6M15 9v6M9 9H7a2 2 0 1 1 2-2zM9 15H7a2 2 0 1 0 2 2zM15 9h2a2 2 0 1 0-2-2zM15 15h2a2 2 0 1 1-2 2zM9 9h6M9 15h6',
  trash: 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13M10 11v6M14 11v6',
  download: 'M12 4v11M7 11l5 5 5-5M5 20h14',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z',
  eyeoff: 'M4 4l16 16M10.6 6.2A9.5 9.5 0 0 1 12 6c6 0 10 6 10 6a17 17 0 0 1-3.2 3.7M6.5 7.6A17 17 0 0 0 2 12s4 7 10 7c1.6 0 3-.4 4.3-1M9.9 9.9a2.5 2.5 0 0 0 3.2 3.2',
  cpu: 'M7 7h10v10H7zM10 10h4v4h-4zM9 3v4M15 3v4M9 17v4M15 17v4M3 9h4M3 15h4M17 9h4M17 15h4',
  mem: 'M3 8h18v8H3zM7 8v8M11 8v8M15 8v8M19 8v8M6 19v-3M18 19v-3',
  disk: 'M4 12a8 3 0 1 0 16 0 8 3 0 1 0-16 0M4 12v5c0 1.7 3.6 3 8 3s8-1.3 8-3v-5',
  net: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v5M12 7.8v.01',
  bolt: 'M13 3 5 13h6l-1 8 8-10h-6z',
  send: 'M5 12 20 5l-4 15-4-6zM12 14l8-9',
  bell: 'M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15zM10 20a2 2 0 0 0 4 0',
  plus: 'M12 5v14M5 12h14',
  dots: 'M5 12h.01M12 12h.01M19 12h.01',
  pin: 'M9 4h6l-1 6 3 3H7l3-3zM12 13v7',
  filter: 'M4 5h16l-6 7v6l-4 2v-8z',
  layers: 'M12 4l9 5-9 5-9-5zM3 14l9 5 9-5',
  lock: 'M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3M12 14.5v2.5',
  unlock: 'M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 6.8-1.2M12 14.5v2.5',
}

export function Icon({ name, size = 16, ...rest }: { name: keyof typeof P | string; size?: number } & Omit<SVGProps<SVGSVGElement>, 'name'>) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={name === 'record' || name === 'play' || name === 'stop' ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden {...rest}>
      <path d={P[name] ?? P.info} />
    </svg>
  )
}
