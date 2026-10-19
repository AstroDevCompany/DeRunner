import { useId } from 'react'

/** DeRunner mark: a fused D + R monogram in a mint→green gradient. Mirrors branding/logo.svg (letters only, no plate). */
export function Logo({ size = 28, className }: { size?: number; className?: string }) {
  const id = useId().replace(/:/g, '')
  return (
    <svg width={size} height={size} viewBox="190 150 700 720" className={className} aria-label="DeRunner">
      <defs>
        <linearGradient id={`m${id}`} x1="270" y1="240" x2="790" y2="790" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#D3FCE8" />
          <stop offset="0.35" stopColor="#6BEDB7" />
          <stop offset="0.72" stopColor="#18BC82" />
          <stop offset="1" stopColor="#0A8860" />
        </linearGradient>
      </defs>
      <g fill="none" stroke={`url(#m${id})`} strokeWidth="78" strokeLinecap="round" strokeLinejoin="round">
        <path d="M 298 250 V 774" />
        <path d="M 298 250 H 500 C 682 250 792 362 792 512 C 792 662 682 774 500 774 H 298" />
        <path d="M 298 428 H 478 C 566 428 618 466 618 512 C 618 558 566 596 478 596 H 298" />
        <path d="M 492 596 L 693 712" />
      </g>
    </svg>
  )
}
