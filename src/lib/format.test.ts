import { describe, expect, it } from 'vitest'
import { fmtBytes, fmtDuration, fmtRel } from './format'

describe('format', () => {
  it('formats bytes', () => {
    expect(fmtBytes(0)).toBe('0 B')
    expect(fmtBytes(1536)).toBe('1.5 KB')
    expect(fmtBytes(5 * 1024 ** 3)).toBe('5.0 GB')
  })
  it('formats durations', () => {
    expect(fmtDuration(59)).toBe('59s')
    expect(fmtDuration(125)).toBe('2m 05s')
    expect(fmtRel(65_000)).toBe('01:05')
  })
})
