import { Fragment, type ReactNode } from 'react'

function inline(s: string, key: string): ReactNode[] {
  const out: ReactNode[] = []
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*)/g
  let last = 0
  let m: RegExpExecArray | null
  let i = 0
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index))
    const t = m[0]
    if (t.startsWith('**')) out.push(<strong key={`${key}b${i}`}>{t.slice(2, -2)}</strong>)
    else if (t.startsWith('`')) out.push(<code key={`${key}c${i}`}>{t.slice(1, -1)}</code>)
    else out.push(<em key={`${key}e${i}`}>{t.slice(1, -1)}</em>)
    last = m.index + t.length
    i++
  }
  if (last < s.length) out.push(s.slice(last))
  return out
}

/** Minimal Markdown renderer (headings, lists, code fences, bold/italic/code). No raw HTML is ever rendered. */
export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r/g, '').split('\n')
  const blocks: ReactNode[] = []
  let i = 0
  let k = 0
  while (i < lines.length) {
    const l = lines[i]
    if (l.startsWith('```')) {
      const buf: string[] = []
      i++
      while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++])
      i++
      blocks.push(<pre key={k++}><code>{buf.join('\n')}</code></pre>)
    } else if (/^#{1,3}\s/.test(l)) {
      const lvl = l.match(/^#+/)![0].length
      const Tag = (`h${lvl}`) as 'h1' | 'h2' | 'h3'
      blocks.push(<Tag key={k++}>{inline(l.replace(/^#+\s/, ''), `h${k}`)}</Tag>)
      i++
    } else if (/^\s*[-*]\s/.test(l)) {
      const items: string[] = []
      while (i < lines.length && /^\s*[-*]\s/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*]\s/, ''))
      blocks.push(<ul key={k++}>{items.map((x, j) => <li key={j}>{inline(x, `u${k}${j}`)}</li>)}</ul>)
    } else if (/^\s*\d+[.)]\s/.test(l)) {
      const items: string[] = []
      while (i < lines.length && /^\s*\d+[.)]\s/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+[.)]\s/, ''))
      blocks.push(<ol key={k++}>{items.map((x, j) => <li key={j}>{inline(x, `o${k}${j}`)}</li>)}</ol>)
    } else if (l.trim() === '') {
      i++
    } else {
      const buf: string[] = []
      while (i < lines.length && lines[i].trim() !== '' && !/^(```|#{1,3}\s|\s*[-*]\s|\s*\d+[.)]\s)/.test(lines[i])) buf.push(lines[i++])
      blocks.push(<p key={k++}>{buf.map((x, j) => <Fragment key={j}>{j > 0 && <br />}{inline(x, `p${k}${j}`)}</Fragment>)}</p>)
    }
  }
  return <div className="md selectable">{blocks}</div>
}
