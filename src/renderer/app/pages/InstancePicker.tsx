import type { AsyncState } from '../data/useAsync'
import type { InstanceSummary } from '@shared/instance'
import { Badge, Button, Card, Select, Tag } from '../ui'
import { Icon } from '../icons'

function loaderLabel(instance: InstanceSummary): string {
  switch (instance.loader.type) {
    case 'vanilla': return '原版'
    case 'fabric': return 'Fabric'
    case 'quilt': return 'Quilt'
    case 'forge': return 'Forge'
    case 'neoforge': return 'NeoForge'
    default: return '未知加载器'
  }
}

export function InstancePicker({
  selection,
  onRefresh,
  hint,
  badge = '实例级资源',
}: {
  selection: {
    instances: AsyncState<InstanceSummary[]>
    selectedId: string
    setSelectedId: (id: string) => void
    selected: InstanceSummary | null
  }
  onRefresh: () => void
  hint?: string
  badge?: string
}) {
  const { instances, selectedId, setSelectedId, selected } = selection
  return (
    <Card className="asset-instance-bar">
      <div className="asset-instance-bar__main">
        <span className="icon-tile icon-tile--vanilla" aria-hidden="true"><Icon name="instances" className="ico" /></span>
        <div>
          <div className="asset-instance-bar__title"><strong>目标实例</strong><Badge tone="outline">{badge}</Badge></div>
          <p>{hint ?? '存档、截图、游戏日志和崩溃修复都作用于当前实例；只读取真实目录。'}</p>
        </div>
      </div>
      <div className="asset-instance-bar__control">
        <Select
          aria-label="选择目标实例"
          value={selectedId}
          onChange={(event) => setSelectedId(event.target.value)}
          disabled={instances.status === 'loading' || !instances.data?.length}
        >
          {!instances.data?.length ? <option value="">{instances.status === 'loading' ? '读取实例…' : '没有实例'}</option> : null}
          {instances.data?.map((instance) => (
            <option key={instance.id} value={instance.id}>
              {instance.name} · {instance.mcVersion ?? '未知版本'} · {loaderLabel(instance)}
            </option>
          ))}
        </Select>
        <div className="asset-instance-bar__meta">
          {selected ? (
            <>
              <Tag variant={selected.loader.type === 'fabric' ? 'fabric' : selected.loader.type === 'forge' ? 'forge' : selected.loader.type === 'neoforge' ? 'neo' : 'neutral'}>
                {loaderLabel(selected)}
              </Tag>
              <span>{selected.mcVersion ?? '版本未知'}</span>
              <span className="muted">{selected.state === 'ready' ? '可读写' : selected.state}</span>
            </>
          ) : <span className="muted">未选择实例</span>}
        </div>
        <Button size="sm" variant="ghost" icon="refresh" onClick={onRefresh} loading={instances.status === 'loading'}>刷新</Button>
      </div>
    </Card>
  )
}
