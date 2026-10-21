import type { InstanceSummary } from '@shared/instance'
import type { UiErrorInfo } from '../data/backend'
import { Badge, Button } from '../ui'
import { Icon } from '../icons'

export function DeleteInstanceDialog({
  instance,
  running,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  instance: InstanceSummary | null
  running: boolean
  busy: boolean
  error: UiErrorInfo | null
  onCancel: () => void
  onConfirm: () => void
}) {
  if (!instance) return null
  return (
    <div className="instance-delete-backdrop" role="presentation">
      <div className="instance-delete-dialog" role="dialog" aria-modal="true" aria-labelledby="instance-delete-title">
        <div className="instance-delete-dialog__head">
          <span className="instance-delete-dialog__icon"><Icon name="trash" /></span>
          <div>
            <div className="eyebrow">删除实例</div>
            <h2 id="instance-delete-title">删除「{instance.name}」？</h2>
          </div>
        </div>
        <p className="instance-delete-dialog__text">
          该实例将移入启动器回收站，可在「回收站」恢复；共享的 libraries/assets 不会被删除。
        </p>
        <div className="instance-delete-dialog__meta">
          <span className="mono">{instance.dirName}</span>
          <Badge tone={running ? 'warning' : 'outline'} dot>{running ? '运行中' : '未运行'}</Badge>
        </div>
        {running ? (
          <div className="instance-delete-dialog__blocked">
            <Icon name="alert-circle" />
            <span>游戏正在运行，不能删除。请先在主页或游戏内结束该实例后再试。</span>
          </div>
        ) : null}
        {error ? (
          <div className="instance-delete-dialog__error" role="alert">
            <strong>{error.title}</strong>
            <span>{error.detail}{error.code ? `（${error.code}）` : ''}</span>
          </div>
        ) : null}
        <div className="instance-delete-dialog__actions">
          <Button variant="secondary" onClick={onCancel} disabled={busy}>取消</Button>
          <Button variant="danger-ghost" icon="trash" loading={busy} disabled={running || busy} onClick={onConfirm}>
            移入回收站
          </Button>
        </div>
      </div>
    </div>
  )
}
