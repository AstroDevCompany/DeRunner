// Mirrors src-tauri/src/thresholds.rs: normal < 70, warn 70..=90, critical > 90.
export type Level = 'normal' | 'warn' | 'critical'

export const WARN_AT = 70
export const CRIT_ABOVE = 90

export function level(pct: number): Level {
  if (pct > CRIT_ABOVE) return 'critical'
  if (pct >= WARN_AT) return 'warn'
  return 'normal'
}

export const LEVEL_VAR: Record<Level, string> = {
  normal: 'var(--lvl-normal)',
  warn: 'var(--lvl-warn)',
  critical: 'var(--lvl-crit)',
}

export const LEVEL_LABEL: Record<Level, string> = {
  normal: 'Normal',
  warn: 'High',
  critical: 'Critical',
}
