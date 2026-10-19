import { describe, expect, it } from 'vitest'
import { level } from './thresholds'

describe('level', () => {
  it('matches the spec boundaries', () => {
    expect(level(0)).toBe('normal')
    expect(level(69.99)).toBe('normal')
    expect(level(70)).toBe('warn')
    expect(level(90)).toBe('warn')
    expect(level(90.01)).toBe('critical')
    expect(level(300)).toBe('critical')
  })
})
