import { Children, isValidElement, useEffect, useRef, useState } from 'react'
import type {
  ButtonHTMLAttributes,
  ChangeEvent,
  CSSProperties,
  InputHTMLAttributes,
  KeyboardEvent as ReactKeyboardEvent,
  ReactElement,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react'
import type { UiErrorInfo } from './data/backend'
import type { InstanceSummary } from '@shared/instance'
import { Icon, type IconName } from './icons'

export function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ')
}

/**
 * Copies text and reports whether it actually reached the clipboard.
 *
 * Every Chromium permission is denied by default in this app, so
 * `navigator.clipboard.writeText` can reject here. Callers must surface the
 * real outcome instead of assuming success — a silent failure looked like a
 * dead button (the device-code copy never made it to the clipboard).
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Permission denied or insecure context; fall through to the legacy path.
  }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.top = '-1000px'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(area)
    return ok
  } catch {
    return false
  }
}

/**
 * Project artwork (Modrinth `icon_url` / CurseForge logo). Falls back to the
 * package glyph when the URL is missing or the request fails, so a dead CDN
 * never leaves a hole in the list.
 */
export function ProjectIcon({
  src,
  size = 'md',
}: {
  src: string | null | undefined
  size?: 'sm' | 'md'
}) {
  // Remember which URL failed instead of a boolean, so reusing the component
  // with a new `src` renders the new image at once (no stale placeholder frame).
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const usable = Boolean(src) && failedSrc !== src
  return (
    <span className={cx('project-icon', `project-icon--${size}`)} aria-hidden="true">
      {src && usable
        ? <img src={src} alt="" loading="lazy" decoding="async" onError={() => setFailedSrc(src)} />
        : <Icon name="package" />}
    </span>
  )
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'subtle' | 'danger' | 'danger-ghost' | 'link'
type ButtonSize = 'xs' | 'sm' | 'md' | 'lg'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  icon?: IconName
  iconAfter?: IconName
  loading?: boolean
}

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  iconAfter,
  loading = false,
  className,
  children,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      className={cx('btn', `btn--${variant}`, size !== 'md' && `btn--${size}`, loading && 'is-loading', className)}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <span className="spinner" /> : icon ? <Icon name={icon} /> : null}
      {children}
      {iconAfter ? <Icon name={iconAfter} /> : null}
    </button>
  )
}

/**
 * `.btn[disabled]` uses `pointer-events: none`, so a `title` on the disabled
 * button itself never opens. This wrapper keeps the explanation ("等 xx 接入")
 * reachable without changing the button shape or making it clickable.
 */
export function DisabledHint({ hint, children }: { hint: string; children: ReactNode }) {
  return <span className="btn-hint" title={hint}>{children}</span>
}

type Tone = 'success' | 'warning' | 'danger' | 'info' | 'accent' | 'outline' | 'neutral'

export function Badge({ children, tone = 'neutral', dot = false }: { children: ReactNode; tone?: Tone; dot?: boolean }) {
  return <span className={cx('badge', tone !== 'neutral' && `badge--${tone}`, dot && 'badge--dot')}>{children}</span>
}

export function Tag({ children, variant = 'neutral' }: { children: ReactNode; variant?: 'neutral' | 'vanilla' | 'forge' | 'neo' | 'fabric' | 'pack' }) {
  return <span className={cx('tag', variant !== 'neutral' && `tag--${variant}`)}>{children}</span>
}

export function Card({ children, className, pad = true, id, style }: { children: ReactNode; className?: string; pad?: boolean; id?: string; style?: CSSProperties }) {
  return <section className={cx('card', pad && 'card--pad', className)} id={id} style={style}>{children}</section>
}

/**
 * Shared modal using the existing `.dialog-overlay` / `.dialog` design-system
 * classes. Backdrop click closes; the footer owns the explicit confirm action.
 */
export function Dialog({
  title,
  subtitle,
  icon = 'info',
  tone = 'warning',
  wide = false,
  onClose,
  footer,
  children,
}: {
  title: ReactNode
  subtitle?: ReactNode
  icon?: IconName
  tone?: 'info' | 'warning' | 'danger'
  wide?: boolean
  onClose: () => void
  footer?: ReactNode
  children: ReactNode
}) {
  return (
    <div
      className="dialog-overlay is-open"
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}
    >
      <div
        className={cx('dialog', wide && 'dialog--wide')}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
      >
        <div className="dialog__head">
          <span className={cx('dialog__icon', tone === 'danger' && 'dialog__icon--danger')} aria-hidden="true">
            <Icon name={icon} />
          </span>
          <div className="dialog__heading">
            <div className="dialog__title">{title}</div>
            {subtitle ? <div className="dialog__sub">{subtitle}</div> : null}
          </div>
          <button className="dialog__close" type="button" aria-label="关闭" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        <div className="dialog__body">{children}</div>
        {footer ? <div className="dialog__footer">{footer}</div> : null}
      </div>
    </div>
  )
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {subtitle ? <p className="page-sub">{subtitle}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </div>
  )
}

export function SectionHead({ title, action }: { title: ReactNode; action?: ReactNode }) {
  return (
    <div className="section-head">
      <h2>{title}</h2>
      {action}
    </div>
  )
}

export interface PageNavItem {
  key: string
  label: ReactNode
  icon?: IconName
  count?: number
}

/**
 * Secondary navigation inside a page (the reference launcher keeps these
 * sub-menus inside the page instead of the global sidebar). Counts are
 * rendered only when the caller has a real number to show.
 */
export function PageNav({
  items,
  active,
  onChange,
  label = '页面导航',
}: {
  items: PageNavItem[]
  active: string
  onChange: (key: string) => void
  label?: string
}) {
  return (
    <nav className="page-nav" aria-label={label}>
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          className={cx('page-nav__item', item.key === active && 'is-active')}
          aria-current={item.key === active ? 'page' : undefined}
          onClick={() => onChange(item.key)}
        >
          {item.icon ? <Icon name={item.icon} /> : null}
          <span className="page-nav__label">{item.label}</span>
          {typeof item.count === 'number' ? <span className="page-nav__count">{item.count}</span> : null}
        </button>
      ))}
    </nav>
  )
}

export interface PageSubNavItem {
  key: string
  label: ReactNode
  icon?: IconName
  /** Secondary line for the list variant (MC version · loader / shared hint). */
  meta?: ReactNode
  count?: number
  disabled?: boolean
  /** Tooltip / explanation, especially for disabled entries that need a backend. */
  hint?: string
}

/**
 * Reusable page-level secondary menu. Two shapes, matching the reference:
 * - `tabs`: text + 2px accent underline, no filled block (role=tablist/tab).
 * - `list`: left-hand source list with an active row (aria-current=page).
 *
 * Items must come from real page data; do not invent placeholder tabs.
 */
export function PageSubNav({
  variant = 'tabs',
  items,
  active,
  onChange,
  label = '页面导航',
  className,
}: {
  variant?: 'tabs' | 'list'
  items: PageSubNavItem[]
  active: string
  onChange: (key: string) => void
  label?: string
  className?: string
}) {
  const isTabs = variant === 'tabs'
  const moveFocus = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = -1
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % items.length
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index - 1 + items.length) % items.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = items.length - 1
    if (next < 0) return
    const target = items[next]
    if (!target || target.disabled) return
    event.preventDefault()
    onChange(target.key)
    const children = event.currentTarget.parentElement?.children
    const button = children?.[next] as HTMLButtonElement | undefined
    button?.focus()
  }

  return (
    <div
      className={cx('page-subnav', `page-subnav--${variant}`, className)}
      role={isTabs ? 'tablist' : undefined}
      aria-label={label}
    >
      {items.map((item, index) => (
        isTabs ? (
          <button
            key={item.key}
            type="button"
            role="tab"
            className="page-subnav__tab"
            aria-selected={item.key === active}
            disabled={item.disabled}
            title={item.hint}
            onClick={() => onChange(item.key)}
            onKeyDown={(event) => moveFocus(event, index)}
          >
            {item.icon ? <Icon name={item.icon} className="ico ico--sm" /> : null}
            <span>{item.label}</span>
            {typeof item.count === 'number' ? <span className="page-subnav__count">{item.count}</span> : null}
          </button>
        ) : (
          <button
            key={item.key}
            type="button"
            className="page-subnav__item"
            aria-current={item.key === active ? 'page' : undefined}
            disabled={item.disabled}
            title={item.hint}
            onClick={() => onChange(item.key)}
          >
            <span className="page-subnav__item-label">
              {item.icon ? <Icon name={item.icon} className="ico ico--xs" /> : null}
              {item.label}
            </span>
            {item.meta ? <span className="page-subnav__item-meta">{item.meta}</span> : null}
            {typeof item.count === 'number' ? <span className="page-subnav__count">{item.count}</span> : null}
          </button>
        )
      ))}
    </div>
  )
}

export function Banner({
  tone = 'info',
  title,
  children,
  icon,
  actions,
}: {
  tone?: 'info' | 'success' | 'warning' | 'danger'
  title?: ReactNode
  children?: ReactNode
  icon?: IconName
  actions?: ReactNode
}) {
  return (
    <div className={cx('banner', `banner--${tone}`)} role={tone === 'danger' ? 'alert' : undefined}>
      <Icon name={icon ?? (tone === 'success' ? 'check' : tone === 'danger' ? 'alert-circle' : tone === 'warning' ? 'alert' : 'info')} />
      <div className="banner__body">
        {title ? <div className="banner__title">{title}</div> : null}
        {children}
        {actions ? <div className="banner__actions">{actions}</div> : null}
      </div>
    </div>
  )
}

export function EmptyState({
  icon = 'cube',
  title,
  description,
  actions,
  hint,
}: {
  icon?: IconName
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  hint?: ReactNode
}) {
  return (
    <div className="empty">
      <span className="empty__art"><Icon name={icon} /></span>
      <h3>{title}</h3>
      {description ? <p>{description}</p> : null}
      {actions ? <div className="empty__actions">{actions}</div> : null}
      {hint ? <div className="empty__hint">{hint}</div> : null}
    </div>
  )
}

export function Skeleton({ className, style }: { className?: string; style?: CSSProperties }) {
  return <div className={cx('skeleton', className)} style={style} />
}

export function LoadingState({ label = '正在读取…' }: { label?: string }) {
  return (
    <div className="nw-loading" aria-busy="true">
      <div className="row gap-8"><span className="spinner" /><span className="muted">{label}</span></div>
      <Skeleton className="skeleton--title" style={{ width: '38%', marginTop: 16 }} />
      <Skeleton className="skeleton--text" style={{ width: '72%', marginTop: 10 }} />
      <Skeleton className="skeleton--text" style={{ width: '55%', marginTop: 8 }} />
    </div>
  )
}

export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
}: {
  label: ReactNode
  hint?: ReactNode
  error?: ReactNode
  htmlFor?: string
  children: ReactNode
}) {
  return (
    <div className="field">
      <label className="field__label" htmlFor={htmlFor}>{label}</label>
      {children}
      {error ? <span className="field__error">{error}</span> : hint ? <span className="field__hint">{hint}</span> : null}
    </div>
  )
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cx('input', className)} {...rest} />
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cx('textarea', className)} {...rest} />
}

export interface DropdownGroup {
  label?: string
  options: ReadonlyArray<{ value: string; label: string }>
}

/**
 * Controlled dropdown with a popup that always opens below the trigger and
 * eases in. Used by every select-like control in the app so they behave the
 * same; the native <select> popup cannot be positioned or animated here.
 */
export function Dropdown({
  value,
  groups,
  placeholder,
  onChange,
  disabled,
  label,
  className,
}: {
  value: string
  groups: ReadonlyArray<DropdownGroup>
  placeholder: string
  onChange: (next: string) => void
  disabled?: boolean
  label?: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  // Typing narrows the list; the box opens with the cursor in it, so a 280-item
  // version list can be typed into instead of scrolled.
  const query = search.trim().toLowerCase()
  const visibleGroups = query
    ? groups
        .map((group) => ({
          label: group.label,
          options: group.options.filter((option) => option.label.toLowerCase().includes(query)),
        }))
        .filter((group) => group.options.length > 0)
    : groups
  const flatVisible = visibleGroups.flatMap((group) => group.options)
  const current = groups.flatMap((group) => group.options).find((option) => option.value === value)

  const choose = (next: string) => {
    onChange(next)
    setOpen(false)
    setSearch('')
  }

  return (
    <div className={cx('dropdown', className)} ref={rootRef}>
      <button
        type="button"
        className="dropdown__trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        disabled={disabled}
        onClick={() => {
          setSearch('')
          setOpen((previous) => !previous)
        }}
      >
        <span>{current?.label ?? placeholder}</span>
        <Icon name="chevron-down" className="ico ico--xs" />
      </button>
      {open ? (
        <div className="dropdown__menu" role="listbox" aria-label={label}>
          <input
            className="dropdown__search"
            autoFocus
            value={search}
            placeholder="输入筛选…"
            aria-label="筛选选项"
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                if (flatVisible[0]) choose(flatVisible[0].value)
              }
            }}
          />
          {visibleGroups.length === 0 ? (
            <div className="dropdown__empty">没有匹配项</div>
          ) : (
            visibleGroups.map((group, index) => (
              <div key={group.label ?? `group-${index}`}>
                {group.label ? <div className="dropdown__group">{group.label}</div> : null}
                {group.options.map((option) => (
                  <button
                    key={option.value || '__all__'}
                    type="button"
                    role="option"
                    aria-selected={value === option.value}
                    className="dropdown__item"
                    onClick={() => choose(option.value)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  )
}

function nodeText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(nodeText).join('')
  return ''
}

/** Reads <option>/<optgroup> children into the dropdown's data shape. */
function optionsFromChildren(children: ReactNode): DropdownGroup[] {
  const groups: DropdownGroup[] = []
  const unlabeled: DropdownGroup = { options: [] }
  const addOption = (target: DropdownGroup, element: ReactElement<{ value?: string | number; children?: ReactNode; disabled?: boolean }>) => {
    if (element.props.disabled) return
    const text = nodeText(element.props.children)
    const nextValue = element.props.value === undefined ? text : String(element.props.value)
    ;(target.options as Array<{ value: string; label: string }>).push({ value: nextValue, label: text })
  }

  for (const child of Children.toArray(children)) {
    if (!isValidElement(child)) continue
    if (child.type === 'optgroup') {
      const props = child.props as { label?: string; children?: ReactNode }
      const group: DropdownGroup = { label: props.label, options: [] }
      for (const inner of Children.toArray(props.children)) {
        if (isValidElement(inner) && inner.type === 'option') addOption(group, inner as never)
      }
      groups.push(group)
      continue
    }
    if (child.type === 'option') addOption(unlabeled, child as never)
  }
  if (unlabeled.options.length > 0) groups.unshift(unlabeled)
  return groups
}

export function Select({
  className,
  children,
  onChange,
  value,
  disabled,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & { children?: ReactNode }) {
  const groups = optionsFromChildren(children)
  const current = value === undefined || value === null ? '' : String(value)
  return (
    <Dropdown
      className={className}
      value={current}
      groups={groups}
      placeholder={groups[0]?.options[0]?.label ?? '请选择'}
      disabled={disabled}
      label={rest['aria-label'] ?? rest.id}
      onChange={(next) => {
        onChange?.({ target: { value: next } } as unknown as ChangeEvent<HTMLSelectElement>)
      }}
    />
  )
}

export function Switch({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  disabled?: boolean
}) {
  return (
    <button
      className="switch"
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  small = false,
}: {
  value: T
  options: ReadonlyArray<{ value: T; label: ReactNode }>
  onChange: (value: T) => void
  ariaLabel: string
  small?: boolean
}) {
  return (
    <div className={cx('segmented', small && 'segmented--sm')} role="tablist" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function Tabs<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T
  options: ReadonlyArray<{ value: T; label: ReactNode }>
  onChange: (value: T) => void
  ariaLabel: string
}) {
  return (
    <div className="tabs" role="tablist" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option.value}
          className={cx('tab', value === option.value && 'is-active')}
          type="button"
          role="tab"
          aria-selected={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function Progress({
  value,
  tone = 'accent',
  size = 'md',
  label,
}: {
  value?: number | null
  tone?: 'accent' | 'success' | 'danger' | 'warning'
  size?: 'sm' | 'md' | 'lg'
  label?: string
}) {
  const indeterminate = value === null || value === undefined
  const pct = indeterminate ? 0 : Math.max(0, Math.min(100, value))
  return (
    <div
      className={cx('progress', size !== 'md' && `progress--${size}`, tone !== 'accent' && `progress--${tone}`, indeterminate && 'progress--indeterminate')}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : Math.round(pct)}
    >
      <div className="progress__bar" style={indeterminate ? undefined : { width: `${pct}%` }} />
    </div>
  )
}

export function ChannelCode({ children }: { children: ReactNode }) {
  return <code className="nw-channel">{children}</code>
}

export function DataStateNotice({
  info,
  onRetry,
  retryLabel = '重新探测',
}: {
  info: UiErrorInfo
  onRetry?: () => void
  retryLabel?: string
}) {
  const notWired = info.kind === 'not-wired'
  return (
    <section className={cx('nw-panel', 'card', notWired ? 'nw-panel--pending' : 'nw-panel--error')} role={notWired ? undefined : 'alert'}>
      <span className="nw-panel__icon"><Icon name={notWired ? 'flask' : 'alert-circle'} /></span>
      <div className="nw-panel__body">
        <div className="nw-panel__title">
          {info.title}
          <Badge tone={notWired ? 'warning' : 'danger'}>{notWired ? '尚未接入后端' : '错误'}</Badge>
        </div>
        <p className="nw-panel__detail">{info.detail}</p>
        {info.technical ? (
          <p className="nw-panel__detail" data-technical="true">
            技术信息：{info.technical}
            {info.causeCode ? `（${info.causeCode}）` : ''}
          </p>
        ) : null}
        {info.channel ? <div className="nw-panel__channel"><span>尝试通道</span><ChannelCode>{info.channel}</ChannelCode></div> : null}
        <p className="nw-panel__foot">
          这里不会显示示例数据；IPC 接线完成后页面会自动加载真实内容。
          {info.code ? <span className="nw-panel__code"> · {info.code}</span> : null}
        </p>
        {onRetry ? (
          <div className="nw-panel__actions">
            <Button size="sm" variant="secondary" icon="refresh" onClick={onRetry}>{retryLabel}</Button>
          </div>
        ) : null}
      </div>
    </section>
  )
}

export type LaunchUiState =
  | 'not-installed'
  | 'ready'
  | 'installing'
  | 'launching'
  | 'running'
  | 'crashed'
  | 'blocked'
  | 'unknown'

const LAUNCH_LABELS: Record<LaunchUiState, string> = {
  'not-installed': '安装此版本',
  ready: '启动游戏',
  installing: '正在准备…',
  launching: '启动中…',
  running: '游戏运行中',
  crashed: '重新启动',
  blocked: '需要修复',
  unknown: '启动游戏（待接入）',
}

export function LaunchButton({
  state,
  onClick,
  disabled = false,
}: {
  state: LaunchUiState
  onClick?: () => void
  disabled?: boolean
}) {
  const variant =
    state === 'ready'
      ? 'primary'
      : state === 'running'
        ? 'running'
        : state === 'crashed'
          ? 'crashed'
          : state === 'not-installed' || state === 'blocked' || state === 'unknown'
            ? 'secondary'
            : 'primary'
  const busy = state === 'installing' || state === 'launching'
  const locked = disabled || busy || state === 'unknown' || state === 'blocked'
  const icon: IconName | null =
    state === 'not-installed'
      ? 'download'
      : state === 'crashed' || state === 'blocked'
        ? 'refresh'
        : state === 'running'
          ? null
          : 'play'
  return (
    <button
      type="button"
      className={cx('btn', 'btn--lg', `btn--${variant}`, busy && 'is-loading')}
      disabled={locked}
      onClick={onClick}
      aria-label={LAUNCH_LABELS[state]}
    >
      {busy ? <span className="spinner" /> : state === 'running' ? <span className="pulse-dot" /> : icon ? <Icon name={icon} /> : null}
      <span>{LAUNCH_LABELS[state]}</span>
    </button>
  )
}

export function InstanceStateBadge({ state }: { state: InstanceSummary['state'] }) {
  switch (state) {
    case 'ready':
      return <Badge tone="success">就绪</Badge>
    case 'missing-json':
      return <Badge tone="warning">缺版本 JSON</Badge>
    case 'corrupt-json':
      return <Badge tone="danger">JSON 损坏</Badge>
    case 'missing-jar':
      return <Badge tone="warning">缺客户端 JAR</Badge>
    case 'unsupported':
    default:
      return <Badge tone="outline">无法识别</Badge>
  }
}

export function StatusDot({ tone = 'muted' }: { tone?: 'ok' | 'warn' | 'bad' | 'muted' }) {
  return <span className={cx('status-dot', `status-dot--${tone}`)} aria-hidden="true" />
}
