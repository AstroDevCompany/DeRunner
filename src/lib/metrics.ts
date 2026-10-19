import type { Settings } from './types'

export interface Scale {
  cores: number
  memTotal: number
  perCore: boolean
  diskRef: number // bytes/s regarded as 100%
  netRef: number // bytes/s regarded as 100%
}

export function scaleFrom(settings: Settings | null, cores: number, memTotal: number): Scale {
  return {
    cores: Math.max(1, cores),
    memTotal: Math.max(1, memTotal),
    perCore: settings?.cpu_mode === 'per_core',
    diskRef: (settings?.disk_ref_mb_s ?? 500) * 1024 * 1024,
    netRef: ((settings?.net_ref_mbps ?? 1000) * 1_000_000) / 8,
  }
}

/** The CPU number shown to the user. In per-core mode 100 = one full core (may exceed 100). */
export const cpuPct = (raw: number, s: Scale) => (s.perCore ? raw : raw / s.cores)
export const memPct = (bytes: number, s: Scale) => (bytes / s.memTotal) * 100
export const diskPct = (bps: number, s: Scale) => (bps / s.diskRef) * 100
export const netPct = (bps: number, s: Scale) => (bps / s.netRef) * 100
