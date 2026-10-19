import { useEffect, useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useApp, type MenuItemDef } from '@/lib/store'
import { LEVEL_VAR, level as levelOf, type Level } from '@/lib/thresholds'
import { Icon } from './Icon'

export { Icon } from './Icon'
export { Logo } from './Logo'
export { Sparkline } from './Sparkline'
export { Markdown } from './Markdown'

// ------------------------------------------------------------------ basic controls

export function Button({ variant, small, className = '', ...p }: ComponentProps<'button'> & { variant?: 'primary' | 'danger'; small?: boolean }) {
  return <button {...p} className={`btn ${variant === 'primary' ? 'btn-primary' : variant === 'danger' ? 'btn-danger' : ''} ${small ? 'btn-sm' : ''} ${className}`} />
}

export function IconButton({ icon, label, className = '', size = 15, ...p }: ComponentProps<'button'> & { icon: string; label: string; size?: number }) {
  return (
    <button {...p} title={label} aria-label={label} className={`icon-btn ${className}`}>
      <Icon name={icon} size={size} />
    </button>
  )
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button role="switch" aria-checked={checked} aria-label={label} className="toggle" onClick={() => onChange(!checked)} />
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { id: T; label: ReactNode; title?: string }[]; onChange: (v: T) => void; label?: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} aria-pressed={o.id === value} title={o.title} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Chip({ kind, children, title }: { kind?: 'ok' | 'warn' | 'crit'; children: ReactNode; title?: string }) {
  return <span title={title} className={`chip ${kind ? `chip-${kind}` : ''}`}>{children}</span>
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>
}

export function Spinner({ size = 14 }: { size?: number }) {
  return <Icon name="refresh" size={size} className="spin" />
}

export function Empty({ icon = 'info', title, children }: { icon?: string; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-14 text-center text-faint">
      <Icon name={icon} size={30} />
      <div className="text-[14px] font-medium text-dim">{title}</div>
      {children && <div className="max-w-sm text-[12.5px]">{children}</div>}
    </div>
  )
}

export function Row({ title, desc, children }: { title: ReactNode; desc?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 border-b border-line py-3 last:border-0">
      <div className="min-w-0">
        <div className="font-medium">{title}</div>
        {desc && <div className="mt-0.5 text-[12px] text-faint">{desc}</div>}
      </div>
      <div className="flex-none">{children}</div>
    </div>
  )
}

// ------------------------------------------------------------------ usage indicators (color + shape + number)

export const LEVEL_GLYPH: Record<Level, string> = { normal: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z', warn: 'M12 5 21 20H3z', critical: 'M8.5 3h7L21 8.5v7L15.5 21h-7L3 15.5v-7z' }

export function LevelGlyph({ level, size = 10 }: { level: Level; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-label={level} style={{ color: LEVEL_VAR[level] }}>
      <path d={LEVEL_GLYPH[level]} fill="currentColor" opacity={level === 'normal' ? 0.55 : 1} />
    </svg>
  )
}

/** Table cell: number, glyph for warn/critical, and a thin bar. `pct` 0..100+. */
export function UsageCell({ pct, text, sub, level }: { pct: number; text: string; sub?: string; level?: Level }) {
  const lv = level ?? levelOf(pct)
  return (
    <div className="relative flex h-full min-w-0 flex-col justify-center" style={{ color: lv === 'normal' ? undefined : LEVEL_VAR[lv] }}>
      <div className="flex items-center gap-1.5">
        {lv !== 'normal' && <LevelGlyph level={lv} size={9} />}
        <span className={`num truncate ${lv === 'normal' ? 'text-fg' : 'font-semibold'}`}>{text}</span>
      </div>
      {sub && <span className="num truncate text-[10.5px] leading-none text-faint">{sub}</span>}
      <i className="usage-bar" style={{ width: `${Math.min(100, Math.max(0, pct))}%`, color: LEVEL_VAR[lv] }} />
    </div>
  )
}

/** Larger meter used in the system strip and inspector. */
export function Meter({ label, icon, pct, value, sub, spark }: { label: string; icon: string; pct: number; value: string; sub?: ReactNode; spark?: ReactNode }) {
  const lv = levelOf(pct)
  return (
    <div className="glass flex min-w-0 flex-1 flex-col gap-1.5 rounded-2xl px-3.5 py-2.5">
      <div className="flex items-center justify-between text-faint">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide"><Icon name={icon} size={13} />{label}</span>
        {lv !== 'normal' && <span className="flex items-center gap-1 text-[10.5px] font-semibold" style={{ color: LEVEL_VAR[lv] }}><LevelGlyph level={lv} size={9} />{lv === 'critical' ? 'Critical' : 'High'}</span>}
      </div>
      <div className="flex items-end justify-between gap-2">
        <span className="num text-[20px] font-semibold leading-none" style={{ color: lv === 'normal' ? undefined : LEVEL_VAR[lv] }}>{value}</span>
        {spark}
      </div>
      <div className="h-[5px] overflow-hidden rounded-full bg-fg/10" role="meter" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <div className="h-full rounded-full transition-[width] duration-300 ease-out" style={{ width: `${Math.min(100, Math.max(1.5, pct))}%`, background: LEVEL_VAR[lv] }} />
      </div>
      {sub && <div className="num truncate text-[11px] text-faint">{sub}</div>}
    </div>
  )
}

// ------------------------------------------------------------------ dialog

export function Dialog({ open, onClose, title, children, width = 460, footer, top }: { open: boolean; onClose: () => void; title?: ReactNode; children: ReactNode; width?: number; footer?: ReactNode; top?: string }) {
  useEffect(() => {
    if (!open) return
    const h = (e: KeyboardEvent) => e.key === 'Escape' && (e.stopPropagation(), onClose())
    window.addEventListener('keydown', h, true)
    return () => window.removeEventListener('keydown', h, true)
  }, [open, onClose])
  if (!open) return null
  return createPortal(
    <div className="overlay" style={top ? { paddingTop: top } : undefined} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" className="glass-strong pop flex max-h-[76vh] flex-col overflow-hidden rounded-2xl" style={{ width }}>
        {title && (
          <div className="flex items-center justify-between px-5 pb-1 pt-4">
            <h2 className="text-[15px] font-semibold">{title}</h2>
            <IconButton icon="x" label="Close" onClick={onClose} />
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-auto px-5 py-3">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}

export function ConfirmHost() {
  const req = useApp((s) => s.confirmReq)
  const done = (ok: boolean) => {
    req?.resolve(ok)
    useApp.setState({ confirmReq: null })
  }
  return (
    <Dialog
      open={!!req}
      onClose={() => done(false)}
      title={req?.title}
      width={420}
      footer={
        <>
          <Button onClick={() => done(false)}>Cancel</Button>
          <Button variant={req?.danger ? 'danger' : 'primary'} onClick={() => done(true)} autoFocus>{req?.confirmLabel}</Button>
        </>
      }
    >
      <p className="text-dim">{req?.body}</p>
    </Dialog>
  )
}

// ------------------------------------------------------------------ context menu

function MenuList({ items, onClose, depth = 0 }: { items: MenuItemDef[]; onClose: () => void; depth?: number }) {
  const [open, setOpen] = useState<number | null>(null)
  return (
    <div className="glass-strong pop min-w-[200px] rounded-xl p-1 shadow-2xl" role="menu" onMouseLeave={() => depth > 0 && setOpen(null)}>
      {items.map((it, i) =>
        it.separator ? (
          <div key={i} className="my-1 h-px bg-line" />
        ) : (
          <div key={i} className="relative" onMouseEnter={() => setOpen(it.submenu ? i : null)}>
            <button
              role="menuitem"
              disabled={it.disabled}
              className={`flex h-[27px] w-full items-center gap-2 rounded-lg px-2.5 text-left text-[12.5px] disabled:opacity-40 ${it.danger ? 'text-crit hover:bg-crit/10' : 'hover:bg-selected'}`}
              onClick={() => {
                if (it.submenu) return setOpen(i)
                onClose()
                it.onSelect?.()
              }}
            >
              <span className="grid w-4 place-items-center text-dim">{it.checked ? <Icon name="check" size={13} /> : it.icon ? <Icon name={it.icon} size={14} /> : null}</span>
              <span className="flex-1 truncate">{it.label}</span>
              {it.hint && <span className="text-[11px] text-faint">{it.hint}</span>}
              {it.submenu && <Icon name="chevR" size={13} className="text-faint" />}
            </button>
            {it.submenu && open === i && (
              <div className="absolute left-full top-0 z-10 pl-1"><MenuList items={it.submenu} onClose={onClose} depth={depth + 1} /></div>
            )}
          </div>
        ),
      )}
    </div>
  )
}

export function ContextMenuHost() {
  const menu = useApp((s) => s.menu)
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const close = () => useApp.setState({ menu: null })
  useLayoutEffect(() => {
    if (!menu || !ref.current) return
    const r = ref.current.getBoundingClientRect()
    setPos({ x: Math.min(menu.x, window.innerWidth - r.width - 8), y: Math.min(menu.y, window.innerHeight - r.height - 8) })
  }, [menu])
  useEffect(() => {
    if (!menu) return
    const k = (e: KeyboardEvent) => e.key === 'Escape' && close()
    window.addEventListener('keydown', k)
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('keydown', k)
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
    }
  }, [menu])
  if (!menu) return null
  return createPortal(
    <div className="fixed inset-0 z-[60]" onMouseDown={close} onContextMenu={(e) => (e.preventDefault(), close())}>
      <div ref={ref} className="absolute" style={{ left: pos.x || menu.x, top: pos.y || menu.y }} onMouseDown={(e) => e.stopPropagation()}>
        <MenuList items={menu.items} onClose={close} />
      </div>
    </div>,
    document.body,
  )
}

/** Small anchored dropdown built on the same glass menu. */
export function DropdownButton({ label, icon, items, variant, small, disabled }: { label: ReactNode; icon?: string; items: MenuItemDef[]; variant?: 'primary' | 'danger'; small?: boolean; disabled?: boolean }) {
  const ref = useRef<HTMLButtonElement>(null)
  return (
    <Button
      ref={ref}
      small={small}
      variant={variant}
      disabled={disabled}
      onClick={() => {
        const r = ref.current!.getBoundingClientRect()
        useApp.setState({ menu: { x: r.left, y: r.bottom + 4, items } })
      }}
    >
      {icon && <Icon name={icon} size={14} />}
      {label}
      <Icon name="chevD" size={12} className="opacity-60" />
    </Button>
  )
}

// ------------------------------------------------------------------ toasts

export function ToastHost() {
  const toasts = useApp((s) => s.toasts)
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[70] flex w-[340px] flex-col gap-2" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="glass-strong slide-in pointer-events-auto flex items-start gap-2.5 rounded-xl px-3.5 py-2.5 text-[12.5px]">
          <span className="mt-0.5 flex-none" style={{ color: t.kind === 'error' ? 'var(--lvl-crit)' : t.kind === 'success' ? 'var(--lvl-normal)' : 'var(--fg-dim)' }}>
            <Icon name={t.kind === 'error' ? 'alert' : t.kind === 'success' ? 'check' : 'info'} size={15} />
          </span>
          <span className="selectable min-w-0 flex-1 break-words">{t.text}</span>
        </div>
      ))}
    </div>
  )
}
