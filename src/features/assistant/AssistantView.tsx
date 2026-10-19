import { useEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import { aiChat, api } from '@/lib/ipc'
import { useAsync } from '@/lib/hooks'
import { data, errText, useApp } from '@/lib/store'
import { Button, Dialog, Icon, IconButton, Markdown, Spinner } from '@/ui'

interface Msg {
  role: 'user' | 'assistant'
  content: string
  error?: boolean
}
interface Chat {
  msgs: Msg[]
  streaming: boolean
  reqId: number | null
}
const useChat = create<Chat>(() => ({ msgs: [], streaming: false, reqId: null }))

const SUGGESTIONS = [
  'What is using the most CPU right now, and is it expected?',
  'Why might my memory usage be so high?',
  'Is anything behaving unusually on this machine?',
  'Which processes could I safely quit to free up resources?',
]
const PROCESS_SUGGESTIONS = ['What is this process and why is it running?', 'Is its resource usage normal?', 'Why is it using this much CPU or memory?', 'Is it safe to terminate?']

const PROVIDER_LABEL: Record<string, string> = { ollama: 'Ollama', lmstudio: 'LM Studio', openai: 'OpenAI', anthropic: 'Anthropic', openrouter: 'OpenRouter' }

export function AssistantView() {
  const pid = useApp((s) => s.assistantPid)
  const settings = useApp((s) => s.settings)
  const { msgs, streaming } = useChat()
  const [input, setInput] = useState('')
  const [preview, setPreview] = useState(false)
  const end = useRef<HTMLDivElement>(null)
  const proc = pid != null ? data.procs.get(pid) : null
  const provider = settings?.ai.default_provider ?? 'ollama'
  const model = settings?.ai.providers[provider]?.model
  const cloud = ['openai', 'anthropic', 'openrouter'].includes(provider)

  useEffect(() => { end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }) }, [msgs])

  const send = async (text: string) => {
    const t = text.trim()
    if (!t || streaming) return
    setInput('')
    const history = [...useChat.getState().msgs.filter((m) => !m.error), { role: 'user' as const, content: t }]
    useChat.setState({ msgs: [...useChat.getState().msgs, { role: 'user', content: t }, { role: 'assistant', content: '' }], streaming: true })
    const patch = (fn: (m: Msg) => Msg) => useChat.setState((s) => ({ msgs: [...s.msgs.slice(0, -1), fn(s.msgs[s.msgs.length - 1])] }))
    try {
      const id = await aiChat({ messages: history.map(({ role, content }) => ({ role, content })), context: { pid } }, (e) => {
        if (e.type === 'delta') patch((m) => ({ ...m, content: m.content + e.text }))
        else if (e.type === 'error') { patch((m) => ({ ...m, content: m.content || e.message, error: true })); useChat.setState({ streaming: false, reqId: null }) }
        else useChat.setState({ streaming: false, reqId: null })
      })
      useChat.setState({ reqId: id })
    } catch (e) {
      patch((m) => ({ ...m, content: errText(e), error: true }))
      useChat.setState({ streaming: false })
    }
  }
  const stop = () => {
    const id = useChat.getState().reqId
    if (id != null) api.aiCancel(id)
    useChat.setState({ streaming: false, reqId: null })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5">
      <div className="flex items-center gap-2 px-0.5 text-[12px] text-dim">
        <span className="chip chip-ok"><Icon name="sparkles" size={11} />{PROVIDER_LABEL[provider]}{model ? ` · ${model}` : ''}</span>
        {!model && <button className="chip chip-warn hover:brightness-110" onClick={() => useApp.getState().setView('settings', 'ai')}>Choose a model in Settings</button>}
        {cloud && <><span className="text-faint">Cloud provider: your questions and a redacted telemetry snapshot are sent to {PROVIDER_LABEL[provider]}.</span><button className="underline" onClick={() => setPreview(true)}>Preview data</button></>}
        {!cloud && <span className="text-faint">Runs locally. Nothing leaves this machine.</span>}
        <div className="ml-auto flex items-center gap-1">
          <Button small onClick={() => useApp.getState().setView('settings', 'ai')}><Icon name="gear" size={12} />Providers</Button>
          <Button small onClick={() => useChat.setState({ msgs: [] })} disabled={!msgs.length || streaming}>Clear</Button>
        </div>
      </div>

      <div className="glass min-h-0 flex-1 overflow-auto rounded-2xl p-4">
        {msgs.length === 0 ? (
          <div className="mx-auto flex h-full max-w-[560px] flex-col items-center justify-center gap-5 text-center">
            <span className="grid h-14 w-14 place-items-center rounded-2xl text-white shadow-lg" style={{ background: 'var(--accent-grad)' }}><Icon name="sparkles" size={26} /></span>
            <div><h2 className="text-[19px] font-semibold">Ask about your processes</h2><p className="mt-1 text-dim">The assistant sees live telemetry (top consumers, recent anomaly signals{proc ? `, and details for ${proc.name}` : ''}). It explains and suggests; you decide what to do.</p></div>
            <div className="flex flex-wrap justify-center gap-2">{(proc ? PROCESS_SUGGESTIONS : SUGGESTIONS).map((s) => <button key={s} className="btn !h-auto !whitespace-normal !py-1.5 text-left" onClick={() => send(s)}>{s}</button>)}</div>
          </div>
        ) : (
          <div className="mx-auto flex max-w-[780px] flex-col gap-4">
            {msgs.map((m, i) => (
              <div key={i} className={m.role === 'user' ? 'flex justify-end' : 'flex gap-3'}>
                {m.role === 'assistant' && <span className="mt-0.5 grid h-7 w-7 flex-none place-items-center rounded-lg text-white" style={{ background: 'var(--accent-grad)' }}><Icon name="sparkles" size={14} /></span>}
                {m.role === 'user' ? <div className="selectable max-w-[80%] rounded-2xl rounded-br-md bg-selected px-3.5 py-2">{m.content}</div>
                  : m.error ? <div className="selectable min-w-0 rounded-xl bg-crit/10 px-3.5 py-2.5 text-crit">{m.content}</div>
                    : <div className="min-w-0 flex-1">{m.content ? <Markdown text={m.content} /> : <Spinner />}{streaming && i === msgs.length - 1 && m.content && <span className="pulse ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 rounded-sm bg-accent-2" />}</div>}
              </div>
            ))}
            <div ref={end} />
          </div>
        )}
      </div>

      <div className="glass rounded-2xl p-2.5">
        {proc && (
          <div className="mb-2 flex items-center gap-2 px-1"><span className="chip chip-ok"><Icon name="cpu" size={11} />About {proc.name} <span className="num opacity-70">{proc.pid}</span><button className="ml-1 opacity-70 hover:opacity-100" aria-label="Remove process context" onClick={() => useApp.setState({ assistantPid: null })}><Icon name="x" size={11} /></button></span></div>
        )}
        <div className="flex items-end gap-2">
          <textarea className="input !min-h-[40px] flex-1" rows={1} value={input} placeholder="Ask about a process, a slowdown, or an anomaly…" onChange={(e) => { setInput(e.target.value); e.target.style.height = 'auto'; e.target.style.height = Math.min(140, e.target.scrollHeight) + 'px' }}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input) } }} aria-label="Message" />
          {streaming ? <Button onClick={stop}><Icon name="stop" size={11} />Stop</Button> : <Button variant="primary" onClick={() => send(input)} disabled={!input.trim()}><Icon name="send" size={13} />Send</Button>}
        </div>
        <div className="mt-1.5 px-1 text-[11px] text-faint">Enter to send · Shift+Enter for a new line · Answers can be wrong; verify before acting.</div>
      </div>
      <PreviewDialog open={preview} onClose={() => setPreview(false)} pid={pid} />
    </div>
  )
}

function PreviewDialog({ open, onClose, pid }: { open: boolean; onClose: () => void; pid: number | null }) {
  const d = useAsync(() => api.aiContextPreview({ pid }), [pid, open], open)
  return (
    <Dialog open={open} onClose={onClose} title="Data sent with your question" width={640} footer={<Button onClick={onClose}>Close</Button>}>
      <p className="mb-2 text-[12.5px] text-dim">This telemetry snapshot is attached to every request (paths and secret-looking values are redacted when "Redact" is on in Settings → AI).</p>
      {d.loading ? <Spinner /> : <pre className="selectable max-h-[50vh] overflow-auto whitespace-pre-wrap rounded-xl bg-fg/5 p-3 font-mono text-[11.5px]">{d.data ?? d.error}</pre>}
    </Dialog>
  )
}
void IconButton
