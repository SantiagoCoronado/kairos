import type { InputHTMLAttributes, ButtonHTMLAttributes, SelectHTMLAttributes } from 'react'

export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}

export function Input({
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement>): React.JSX.Element {
  return (
    <input
      className={cn(
        'bg-raised border border-border rounded-md px-2.5 py-1.5 text-[13px] text-text',
        'placeholder:text-faint focus:outline-none focus:border-border-strong',
        className
      )}
      {...props}
    />
  )
}

export function Button({
  className,
  variant = 'default',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'ghost' | 'accent'
}): React.JSX.Element {
  return (
    <button
      className={cn(
        'px-2.5 py-1.5 rounded-md text-[13px] transition-colors disabled:opacity-40',
        variant === 'default' &&
          'bg-raised border border-border text-text hover:border-border-strong',
        variant === 'ghost' && 'text-muted hover:text-text hover:bg-raised',
        variant === 'accent' && 'bg-accent/15 border border-accent/40 text-accent hover:bg-accent/25',
        className
      )}
      {...props}
    />
  )
}

export function Select({
  className,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>): React.JSX.Element {
  return (
    <select
      className={cn(
        'bg-raised border border-border rounded-md px-2 py-1.5 text-[13px] text-text',
        'focus:outline-none focus:border-border-strong',
        className
      )}
      {...props}
    />
  )
}

export function Chip({
  children,
  tone = 'muted',
  onClick
}: {
  children: React.ReactNode
  tone?: 'muted' | 'accent' | 'danger' | 'ok'
  onClick?: () => void
}): React.JSX.Element {
  const Tag = onClick ? 'button' : 'span'
  return (
    <Tag
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-mono text-[10.5px] tracking-wide',
        tone === 'muted' && 'bg-raised text-muted',
        tone === 'accent' && 'bg-accent/15 text-accent',
        tone === 'danger' && 'bg-danger/15 text-danger',
        tone === 'ok' && 'bg-ok/15 text-ok',
        onClick && 'hover:brightness-125 cursor-pointer'
      )}
    >
      {children}
    </Tag>
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
}): React.JSX.Element {
  return (
    <div className="inline-flex rounded-md border border-border overflow-hidden">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'px-2.5 py-1 text-[12px] transition-colors',
            value === o.value ? 'bg-raised text-text' : 'text-muted hover:text-text'
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function EmptyState({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-center justify-center py-16">
      <p className="text-faint text-[13px]">{children}</p>
    </div>
  )
}
