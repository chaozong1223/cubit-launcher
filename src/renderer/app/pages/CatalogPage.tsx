import { useEffect, useState } from 'react'
import type { InstanceSummary } from '@shared/instance'
import { useBackend } from '../data/BackendContext'
import { describeError } from '../data/backend'
import { useAsync } from '../data/useAsync'
import { navigate } from '../router'
import {
  Badge,
  Banner,
  Button,
  Card,
  DataStateNotice,
  PageHeader,
  Segmented,
  Select,
  Skeleton,
  Tag,
} from '../ui'
import { Icon } from '../icons'
import { loaderLabel } from './catalogUtils'
import { CatalogSearch } from './CatalogSearch'
import { CatalogUpdates } from './CatalogUpdates'

export type CatalogMode = 'search' | 'updates'

/** One page title per category, so the header names what the list shows. */
const CATEGORY_TITLES: Record<string, string> = {
  mod: '模组',
  datapack: '数据包',
  modpack: '整合包',
  resourcepack: '资源包',
  shader: '光影',
}

export function CatalogPage({ mode, category }: { mode: CatalogMode; category?: string }) {
  const backend = useBackend()
  const instances = useAsync(() => backend.instances.list(), [])
  const [selectedId, setSelectedId] = useState('')

  useEffect(() => {
    if (!instances.data || instances.data.length === 0) return
    if (selectedId && instances.data.some((instance) => instance.id === selectedId)) return
    const ready = instances.data.find((instance) =>
      instance.state === 'ready' &&
      Boolean(instance.mcVersion) &&
      instance.loader.type !== 'vanilla' &&
      instance.loader.type !== 'unknown',
    ) ?? instances.data.find((instance) => instance.state === 'ready') ?? instances.data[0]
    setSelectedId(ready.id)
  }, [instances.data, selectedId])

  const selected: InstanceSummary | null =
    instances.data?.find((instance) => instance.id === selectedId) ?? null
  const instancesPending = instances.status === 'not-wired' || instances.status === 'error'
  const instancesInfo = instancesPending ? describeError(instances.error) : null

  return (
    <>
      <PageHeader
        title={mode === 'updates' ? '模组更新' : CATEGORY_TITLES[category ?? 'mod'] ?? '资源库'}
        subtitle={mode === 'updates'
          ? '检查已装模组的可更新项、风险与更新日志；更新前会把旧文件移入回收站，可手动回滚。'
          : `只显示${CATEGORY_TITLES[category ?? 'mod'] ?? '资源库'}；换类别请点上方标签，切走会清空筛选。`}
        actions={
          <>
            <Badge tone="accent" dot>{mode === 'updates' ? 'SHA-1 反查' : 'Modrinth 实时'}</Badge>
            <Button size="sm" variant="secondary" icon="refresh" onClick={instances.reload} loading={instances.status === 'loading'}>
              刷新实例
            </Button>
          </>
        }
      />

      <Card className="catalog-source-card">
        <div className="catalog-source__main">
          <span className="icon-tile icon-tile--forge" aria-hidden="true"><Icon name="package" className="ico" /></span>
          <div>
            <div className="catalog-source__title">
              <strong>Modrinth</strong>
              <Badge tone="success">搜索 / 详情 / 安装</Badge>
              <Badge tone="outline">CurseForge 仅打开项目页</Badge>
            </div>
            <p>
              搜索、项目详情、版本、下载和更新都走 <code className="mono">mc:catalog:*</code>；
              CurseForge 不调用 API，也不代下载，只根据 slug 打开官网项目页。
            </p>
          </div>
        </div>
        <div className="catalog-source__select">
          <label htmlFor="catalog-instance-select">目标实例</label>
          <Select
            id="catalog-instance-select"
            value={selectedId}
            onChange={(event) => setSelectedId(event.target.value)}
            disabled={instances.status === 'loading' || !instances.data?.length}
          >
            {!instances.data?.length ? <option value="">{instances.status === 'loading' ? '读取实例…' : '没有实例'}</option> : null}
            {instances.data?.map((instance) => (
              <option key={instance.id} value={instance.id}>
                {instance.name} · {instance.mcVersion ?? '未知版本'} · {loaderLabel(instance.loader.type)}
              </option>
            ))}
          </Select>
          {selected ? (
            <div className="catalog-source__meta">
              <Tag variant={selected.loader.type === 'fabric' ? 'fabric' : selected.loader.type === 'forge' ? 'forge' : selected.loader.type === 'neoforge' ? 'neo' : selected.loader.type === 'vanilla' ? 'vanilla' : 'neutral'}>
                {loaderLabel(selected.loader.type)}
              </Tag>
              <span>{selected.mcVersion ?? '版本未知'}</span>
              <span className="muted">{selected.dirName}</span>
            </div>
          ) : <span className="catalog-source__meta muted">未选择实例；资源仍可浏览，安装/更新会禁用。</span>}
        </div>
      </Card>

      <div className="catalog-modebar">
        <Segmented
          value={mode}
          ariaLabel="资源库视图"
          options={[
            { value: 'search', label: '资源库搜索' },
            { value: 'updates', label: '模组更新' },
          ]}
          onChange={(next) => navigate(next === 'search' ? '/catalog' : '/updates')}
        />
        <span className="catalog-modebar__hint">
          {mode === 'search'
            ? '选一个项目查看版本、兼容性和预发布开关。'
            : '检查只读取已装 mod 的 SHA-1 并反查 Modrinth；不会扫描其它文件。'}
        </span>
      </div>

      {instancesInfo ? (
        <DataStateNotice info={instancesInfo} onRetry={instances.reload} retryLabel="重新读取实例" />
      ) : null}

      {instances.status === 'loading' ? (
        <Card className="catalog-loading"><Skeleton className="skeleton--text" style={{ width: '40%' }} /><Skeleton className="skeleton--text" style={{ width: '70%', marginTop: 8 }} /></Card>
      ) : null}

      {instances.status === 'ready' && instances.data?.length === 0 ? (
        <Banner tone="warning" title="还没有实例">
          资源库可以搜索，但一键安装和更新需要目标实例。请先在「安装与下载」创建版本，或在实例页导入实例。
        </Banner>
      ) : null}

      {mode === 'search' ? (
        <CatalogSearch instance={selected} category={category} />
      ) : (
        <CatalogUpdates instance={selected} />
      )}
    </>
  )
}
