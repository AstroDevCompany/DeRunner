import { useCallback, useEffect, useRef, useState } from 'react'
import { errText } from './store'

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[], enabled = true) {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: enabled })
  const seq = useRef(0)
  const run = useCallback(() => {
    const id = ++seq.current
    setState((s) => ({ ...s, loading: true, error: null }))
    fn().then(
      (data) => id === seq.current && setState({ data, error: null, loading: false }),
      (e) => id === seq.current && setState({ data: null, error: errText(e), loading: false }),
    )
  }, deps) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (enabled) run()
    return () => {
      seq.current++
    }
  }, [run, enabled])
  return { ...state, reload: run }
}

export function useInterval(fn: () => void, ms: number | null) {
  const f = useRef(fn)
  f.current = fn
  useEffect(() => {
    if (ms == null) return
    const id = setInterval(() => f.current(), ms)
    return () => clearInterval(id)
  }, [ms])
}
