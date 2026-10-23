import { useEffect, useMemo, useState } from 'react'
import type { CatalogInstallResult, CatalogProjectType, CatalogVersion } from '@shared/catalog'
import type { InstanceSummary } from '@shared/instance'
import { useBackend } from '../data/BackendContext'
import { describeError, type UiErrorInfo } from '../data/backend'
import { useAsync } from '../data/useAsync'
import { navigate } from '../router'
import {
  Badge,
  Banner,
  Button,
  Card,
  copyToClipboard,
  DataStateNotice,
  Dropdown,
  EmptyState,
  PageHeader,
  ProjectIcon,
  Skeleton,
} from '../ui'
import { Icon } from '../icons'
import { formatBytes, formatDate, formatDownloads, loaderLabel, projectTypeLabel } from './catalogUtils'

/**
 * Standalone project page (`#/project/<id>`).
 *
 * Unlike the old inline detail panel it does NOT filter versions by the
 * selected instance, so a Fabric-only mod opened with a Forge instance still
 * lists its versions (they are marked incompatible instead of hidden).
 */
export function CatalogProjectPage({ projectId }: { projectId: string }) {
  const backend = useBackend()
  const project = useAsync(() => backend.catalog.project(projectId), [projectId])
  const versions = useAsync(() => backend.catalog.versions({ projectId }), [projectId])
  const instances = useAsync(() => backend.instances.list(), [])
  const [instanceId, setInstanceId] = useState(() => window.localStorage.getItem('mcl.global.instanceId') ?? '')
  const [mcFilter, setMcFilter] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ tone: 'success' | 'warning'; text: string } | null>(null)

  /** Open an external page and always report what happened — a silent no-op
   *  looked like a broken button. */
  const openLink = async (kind: 'modrinth' | 'wiki') => {
    const current = project.data
    if (!current) return
    setNotice(null)
    try {
      const result =
        kind === 'modrinth'
          ? await backend.catalog.openPage({ provider: 'modrinth', slug: current.slug })
          : await backend.catalog.openWiki({ query: current.title })
      if (result.opened) {
        setNotice({ tone: 'success', text: '已在浏览器中打开' })
      } else {
        setNotice({ tone: 'warning', text: `系统没有打开浏览器，请手动访问：${result.url}` })
      }
    } catch (cause) {
      const info = describeError(cause)
      setNotice({ tone: 'warning', text: `${info.title}：${info.detail}` })
    }
  }
  const [installing, setInstalling] = useState<string | null>(null)
  const [installed, setInstalled] = useState<CatalogInstallResult | null>(null)
  const [error, setError] = useState<UiErrorInfo | null>(null)

  const list = instances.data ?? []
  const instance: InstanceSummary | null = list.find((entry) => entry.id === instanceId) ?? list[0] ?? null

  useEffect(() => {
    if (!instanceId && instance) setInstanceId(instance.id)
  }, [instanceId, instance])

  const allVersions = versions.data ?? []
  const gameVersions = useMemo(
    () => [...new Set(allVersions.flatMap((version) => version.gameVersions))].slice(0, 24),
    [allVersions],
  )
  const visible = mcFilter
    ? allVersions.filter((version) => version.gameVersions.includes(mcFilter))
    : allVersions

  const compatible = (version: CatalogVersion): boolean => {
    if (!instance) return true
    if (instance.mcVersion && !version.gameVersions.includes(instance.mcVersion)) return false
    const loader = instance.loader.type
    if (loader !== 'vanilla' && version.loaders.length > 0) {
      const wanted = loader === 'neoforge' ? ['neoforge', 'forge'] : [loader]
      if (!version.loaders.some((entry) => wanted.includes(entry))) return false
    }
    return true
  }

  const install = async (version: CatalogVersion) => {
    if (!instance) {
      setError({
        kind: 'error',
        title: '还没有选择目标实例',
        detail: '先在「安装与下载」创建版本，或在上方选择实例，再一键安装。',
        retryable: false,
      })
      return
    }
    setInstalling(version.id)
    setInstalled(null)
    setError(null)
    try {
      const result = await backend.catalog.install({
        instanceId: instance.id,
        projectId,
        versionId: version.id,
        allowPrerelease: version.versionType !== 'release',
      })
      setInstalled(result)
      window.dispatchEvent(new CustomEvent('mcl:instances-changed'))
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setInstalling(null)
    }
  }

  const data = project.data
  const type: CatalogProjectType = data?.projectType ?? 'mod'

  return (
    <>
      <PageHeader
        title={data?.title ?? '项目详情'}
        subtitle={data ? `${projectTypeLabel(type)} · ${formatDownloads(data.downloads)} 次下载 · 来自 Modrinth` : '来自 Modrinth'}
        actions={(
          <div className="row gap-8">
            <Button size="sm" variant="secondary" icon="chevron-left" onClick={() => navigate('/catalog')}>返回资源库</Button>
            {data ? (
              <>
                <Button
                  size="sm"
                  variant="primary"
                  icon="external"
                  onClick={() => void openLink('modrinth')}
                >
                  转到 Modrinth
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  icon="search"
                  onClick={() => void openLink('wiki')}
                >
                  转到 MC 百科
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  icon="copy"
                  onClick={() => {
                    void copyToClipboard(data.title).then((ok) => {
                      setNotice(
                        ok
                          ? { tone: 'success', text: '名称已复制到剪贴板' }
                          : { tone: 'warning', text: '复制失败：剪贴板不可用' },
                      )
                    })
                  }}
                >
                  复制名称
                </Button>
              </>
            ) : null}
          </div>
        )}
      />

      {project.status === 'loading' ? (
        <Card><div className="nw-stack"><Skeleton className="skeleton--title" style={{ width: '38%' }} /><Skeleton className="skeleton--text" style={{ width: '72%', marginTop: 10 }} /></div></Card>
      ) : data ? (
        <Card className="project-head">
          <ProjectIcon src={data.iconUrl} title={data.title} size="md" />
          <div className="project-head__text">
            <div className="row gap-8" style={{ flexWrap: 'wrap' }}>
              <Badge tone="accent">{projectTypeLabel(type)}</Badge>
              {data.categories.slice(0, 5).map((category) => <Badge key={category} tone="outline">{category}</Badge>)}
            </div>
            <p className="project-head__desc">{data.description}</p>
          </div>
        </Card>
      ) : project.status === 'error' || project.status === 'not-wired' ? (
        <DataStateNotice info={describeError(project.error)} onRetry={project.reload} />
      ) : null}

      {notice ? <Banner tone={notice.tone} title={notice.text} /> : null}
      {error ? <Banner tone="danger" title={error.title}>{error.detail}</Banner> : null}
      {installed ? (
        installed.modpackImport ? (
          <Banner tone="success" title={`已开始导入整合包「${installed.modpackImport.name}」`}>
            在新实例中导入 {installed.modpackImport.totalFiles} 个文件。
            <Button size="xs" variant="ghost" icon="instances" onClick={() => navigate('/home')}>回主页查看进度 →</Button>
          </Banner>
        ) : (
          <Banner tone="success" title={`已安装 ${installed.filename}`}>
            目标文件：<span className="mono">{installed.targetPath}</span>；{formatBytes(installed.size)}。
          </Banner>
        )
      ) : null}

      <Card className="project-target">
        <Field label="装到哪个实例">
          <Dropdown
            value={instance?.id ?? ''}
            placeholder={list.length === 0 ? '还没有实例' : '选择实例'}
            onChange={setInstanceId}
            groups={[{
              options: list.map((entry) => ({
                value: entry.id,
                label: `${entry.name}${entry.mcVersion ? ` · ${entry.mcVersion}` : ''}${entry.loader.type !== 'vanilla' ? ` · ${entry.loader.type}` : ''}`,
              })),
            }]}
          />
        </Field>
      </Card>

      <Card className="project-versions">
        <div className="row gap-8" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <strong className="project-versions__title">版本</strong>
          <div style={{ width: 200 }}>
            <Dropdown
              value={mcFilter ?? '__all__'}
              placeholder="全部 MC 版本"
              onChange={(next) => setMcFilter(next === '__all__' ? null : next)}
              groups={[{
                options: [
                  { value: '__all__', label: '全部 MC 版本' },
                  ...gameVersions.map((version) => ({ value: version, label: version })),
                ],
              }]}
            />
          </div>
          <span className="muted" style={{ fontSize: 11.5 }}>{visible.length} / {allVersions.length} 个版本</span>
        </div>

        {versions.status === 'loading' ? (
          <div className="nw-stack" style={{ marginTop: 12 }}>
            <Skeleton className="skeleton--text" style={{ width: '60%' }} />
            <Skeleton className="skeleton--text" style={{ width: '78%', marginTop: 8 }} />
          </div>
        ) : visible.length === 0 ? (
          <EmptyState
            icon="package"
            title="这个筛选下没有版本"
            description={allVersions.length === 0 ? '该项目在 Modrinth 上没有可用文件。' : '换一个 MC 版本标签试试。'}
          />
        ) : (
          <div className="project-version-list">
            {visible.map((version) => {
              const ok = compatible(version)
              return (
                <div key={version.id} className={ok ? 'project-version' : 'project-version is-blocked'}>
                  <div className="project-version__main">
                    <div className="project-version__name">{version.name}</div>
                    <div className="project-version__meta">
                      <span className="mono">{version.versionNumber}</span>
                      <span>{version.gameVersions.slice(0, 3).join(', ')}{version.gameVersions.length > 3 ? ` +${version.gameVersions.length - 3}` : ''}</span>
                      {version.loaders.length > 0 ? <span>{version.loaders.map(loaderLabel).join(' / ')}</span> : null}
                      {version.datePublished ? <span>{formatDate(version.datePublished)}</span> : null}
                      <span>{formatDownloads(version.downloads)}</span>
                      <Badge tone={version.versionType === 'release' ? 'success' : 'outline'}>
                        {version.versionType === 'release' ? '正式版' : version.versionType === 'beta' ? 'beta' : 'alpha'}
                      </Badge>
                      {!ok ? <Badge tone="warning">与当前实例不匹配</Badge> : null}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant={ok ? 'primary' : 'secondary'}
                    loading={installing === version.id}
                    onClick={() => void install(version)}
                  >
                    {installing === version.id ? '安装中…' : '安装'}
                  </Button>
                </div>
              )
            })}
          </div>
        )}
        {allVersions.length > 60 && mcFilter === null ? (
          <p className="hint" style={{ marginTop: 10 }}>共 {allVersions.length} 个版本，选一个 MC 版本标签可缩小范围。</p>
        ) : null}
      </Card>
    </>
  )
}

/** Local copy so this page does not depend on the search page's internals. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <span className="field__label">{label}</span>
      {children}
    </label>
  )
}
