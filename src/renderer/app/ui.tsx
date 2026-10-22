import { useState } from 'react'
import type {
  ButtonHTMLAttributes,
  CSSProperties,
  InputHTMLAttributes,
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

export function Select({
  className,
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & { children?: ReactNode }) {
  return (
    <div className="select-wrap">
      <select className={cx('select', className)} {...rest}>{children}</select>
      <Icon name="chevron-down" />
    </div>
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
