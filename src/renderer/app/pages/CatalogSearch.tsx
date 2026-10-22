import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  CatalogInstallResult,
  CatalogPageResult,
  CatalogProjectType,
  CatalogSearchHit,
  CatalogVersion,
} from '@shared/catalog'
import type { InstanceSummary } from '@shared/instance'
import { useBackend } from '../data/BackendContext'
import { describeError, type CatalogInstallProgressEvent, type UiErrorInfo } from '../data/backend'
import { useAsync } from '../data/useAsync'
import {
  Badge,
  Banner,
  Button,
  Card,
  DataStateNotice,
  EmptyState,
  Field,
  Dropdown,
  Input,
  Progress,
  ProjectIcon,
  Select,
  Skeleton,
  Tag,
} from '../ui'
import { Icon } from '../icons'
import { navigate } from '../router'
import {
  formatBytes,
  formatDate,
  formatDownloads,
  loaderLabel,
  LOADER_OPTIONS,
  PROJECT_TYPE_OPTIONS,
  projectCompatibility,
  projectTypeLabel,
  shortText,
  versionCompatibility,
  versionTypeLabel,
} from './catalogUtils'

const PAGE_SIZE = 20

/** One icon per project type, used by the category chips above the filters. */
const TYPE_ICONS: Record<string, Parameters<typeof Icon>[0]['name']> = {
  mod: 'package',
  modpack: 'cube',
  resourcepack: 'folder',
  shader: 'sun',
}



interface SearchFilters {
  query: string
  projectType: CatalogProjectType
  loaders: string[]
  gameVersion?: string
  offset: number
}

function HitCard({
  hit,
  instance,
  installing,
  onOpen,
  onInstall,
}: {
  hit: CatalogSearchHit
  instance: InstanceSummary | null
  installing: boolean
  onOpen: () => void
  onInstall: () => void
}) {
  const compatibility = projectCompatibility(hit, instance)
  return (
    <article className="catalog-row">
      <ProjectIcon src={hit.iconUrl} />
      <div className="catalog-row__main">
        <div className="catalog-row__title">
          <strong>{hit.title}</strong>
          <span className="catalog-row__by">
            {hit.author ?? '作者未知'} · {projectTypeLabel(hit.projectType)}
          </span>
        </div>
        <p className="catalog-row__desc">{shortText(hit.description, 220) || '没有简介'}</p>
        <div className="catalog-row__tags">
          {hit.loaders.slice(0, 3).map((loader) => <Tag key={loader} variant={loader === 'fabric' ? 'fabric' : loader === 'forge' ? 'forge' : loader === 'neoforge' ? 'neo' : 'neutral'}>{loaderLabel(loader)}</Tag>)}
          {hit.gameVersions.slice(0, 3).map((version) => <Tag key={version}>{version}</Tag>)}
          {hit.gameVersions.length > 3 ? <span className="subtle">+{hit.gameVersions.length - 3}</span> : null}
        </div>
        {!compatibility.ok ? <div className="catalog-row__reason">{compatibility.reason}</div> : null}
      </div>
      <div className="catalog-row__side">
        <span className="catalog-row__downloads">{formatDownloads(hit.downloads)} 下载</span>
        <div className="catalog-row__actions">
          <Button size="sm" variant="secondary" icon="search" onClick={onOpen}>详情</Button>
          <Button
            size="sm"
            variant="primary"
            icon="download"
            loading={installing}
            disabled={!compatibility.ok || installing}
            title={compatibility.reason ?? '安装最新兼容版本'}
            onClick={onInstall}
          >
            一键安装
          </Button>
        </div>
      </div>
    </article>
  )
}

function ProjectDetail({
  hit,
  instance,
  onClose,
}: {
  hit: CatalogSearchHit
  instance: InstanceSummary | null
  onClose: () => void
}) {
  const backend = useBackend()
  const project = useAsync(() => backend.catalog.project(hit.slug), [hit.slug])
  const projectId = project.data?.id ?? hit.projectId
  const instanceLoader = instance && instance.loader.type !== 'vanilla' && instance.loader.type !== 'unknown'
    ? instance.loader.type
    : null
  const versions = useAsync(
    () => backend.catalog.versions({
      projectId,
      ...(instance?.mcVersion ? { gameVersion: instance.mcVersion } : {}),
      ...(instanceLoader ? { loader: instanceLoader } : {}),
    }),
    [projectId, instance?.id],
  )
  const [allowPrerelease, setAllowPrerelease] = useState(false)
  const [installing, setInstalling] = useState<string | null>(null)
  const [progress, setProgress] = useState<CatalogInstallProgressEvent | null>(null)
  const [installed, setInstalled] = useState<CatalogInstallResult | null>(null)
  const [error, setError] = useState<UiErrorInfo | null>(null)
  const [pageResult, setPageResult] = useState<CatalogPageResult | null>(null)
  const [pageError, setPageError] = useState<UiErrorInfo | null>(null)

  useEffect(() => {
    const off = backend.catalog.subscribeInstallProgress((event) => {
      if (event.projectId === hit.projectId) setProgress(event)
    })
    return off
  }, [backend, hit.projectId])

  const install = async (version: CatalogVersion) => {
    if (!instance) {
      setError({ kind: 'error', title: '没有目标实例', detail: '请先在顶部选择实例。', retryable: false })
      return
    }
    const compatibility = versionCompatibility(version, instance, hit.projectType)
    if (!compatibility.ok) {
      setError({ kind: 'error', title: '版本不兼容', detail: compatibility.reason ?? '无法安装', retryable: false })
      return
    }
    if (version.versionType !== 'release' && !allowPrerelease) {
      setError({ kind: 'error', title: '需要确认测试版', detail: `${versionTypeLabel(version.versionType)} 需要先勾选“允许测试版/内测版”。`, retryable: false })
      return
    }
    setInstalling(version.id)
    setInstalled(null)
    setError(null)
    setProgress(null)
    try {
      const result = await backend.catalog.install({
        instanceId: instance.id,
        projectId: hit.projectId,
        versionId: version.id,
        allowPrerelease,
      })
      setInstalled(result)
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setInstalling(null)
    }
  }

  const openPage = async () => {
    setPageError(null)
    try {
      setPageResult(await backend.catalog.openPage({ provider: 'modrinth', slug: hit.slug }))
    } catch (cause) {
      setPageError(describeError(cause))
    }
  }

  const body = project.data?.body?.trim() ?? ''
  return (
    <Card className="catalog-detail">
      <div className="catalog-detail__head">
        <div>
          <div className="catalog-detail__eyebrow">Modrinth 项目详情</div>
          <h2>{project.data?.title ?? hit.title}</h2>
          <div className="catalog-detail__byline">
            {hit.author ?? '作者未知'} · {formatDownloads(project.data?.downloads ?? hit.downloads)} 下载
            <Badge tone="outline">{projectTypeLabel(hit.projectType)}</Badge>
          </div>
        </div>
        <div className="row gap-8">
          <Button size="sm" variant="secondary" icon="external" onClick={() => void openPage()}>打开 Modrinth 页面</Button>
          <Button size="sm" variant="ghost" icon="close" onClick={onClose}>关闭</Button>
        </div>
      </div>

      {project.status === 'loading' ? <Skeleton className="skeleton--text" style={{ width: '70%' }} /> : null}
      {project.status === 'not-wired' || project.status === 'error' ? (
        <DataStateNotice info={describeError(project.error)} onRetry={project.reload} />
      ) : null}
      {project.status === 'ready' ? (
        <>
          <p className="catalog-detail__desc">{shortText(project.data?.description ?? hit.description, 500)}</p>
          {body ? (
            <details className="catalog-detail__body">
              <summary>展开项目介绍（来自 Modrinth）</summary>
              <pre>{body.slice(0, 6000)}</pre>
            </details>
          ) : null}
          <div className="catalog-detail__tags">
            {project.data?.categories.slice(0, 8).map((category) => <Tag key={category}>{category}</Tag>)}
            {project.data?.loaders.map((loader) => <Tag key={loader} variant="fabric">{loaderLabel(loader)}</Tag>)}
          </div>
        </>
      ) : null}

      {pageResult ? <Banner tone={pageResult.opened ? 'success' : 'info'}>{pageResult.opened ? `已在浏览器打开 ${pageResult.url}` : `项目页：${pageResult.url}`}</Banner> : null}
      {pageError ? <div className="nw-inline-error">{pageError.title}：{pageError.detail}</div> : null}
      {error ? <div className="nw-inline-error">{error.title}：{error.detail}</div> : null}
      {installed ? (
        <Banner tone="success" title={`已安装 ${installed.filename}`}>
          目标文件：<span className="mono">{installed.targetPath}</span>；{formatBytes(installed.size)}；校验 SHA-1 {installed.sha1 ? '通过' : '—'}。
        </Banner>
      ) : null}
      {progress ? (
        <div className="catalog-progress">
          <div className="row gap-8"><Icon name="download" /><strong>{progress.stage}</strong><span className="muted">{progress.percent === null ? '大小未知' : `${Math.round(progress.percent)}%`}</span></div>
          <Progress value={progress.percent} label="资源安装进度" />
        </div>
      ) : null}

      <div className="catalog-detail__versions-head">
        <h3>版本</h3>
        <span className="muted">按 MC 版本 / 加载器筛选；点击版本右侧安装。</span>
      </div>
      {hit.projectType !== 'mod' ? (
        <Banner tone="warning" title="当前后端只提供模组一键安装">资源包、光影或整合包请使用“打开 Modrinth 页面”下载后，在实例的对应页导入。这里不会伪造安装成功。</Banner>
      ) : null}
      <label className="catalog-prerelease">
        <input type="checkbox" checked={allowPrerelease} onChange={(event) => setAllowPrerelease(event.target.checked)} />
        <span>允许安装 beta / alpha 测试版（默认只装正式版；此勾选仅对本次详情生效）</span>
      </label>
      {versions.status === 'loading' ? <Skeleton className="skeleton--text" style={{ width: '50%' }} /> : null}
      {versions.status === 'not-wired' || versions.status === 'error' ? (
        <DataStateNotice info={describeError(versions.error)} onRetry={versions.reload} />
      ) : null}
      {versions.status === 'ready' && versions.data?.length === 0 ? (
        <EmptyState icon="package" title="没有匹配版本" description="换一个目标实例或打开 Modrinth 项目页查看全部版本。" />
      ) : null}
      {versions.status === 'ready' && versions.data?.length ? (
        <div className="catalog-version-list">
          {versions.data.map((version) => {
            const compatibility = versionCompatibility(version, instance, hit.projectType)
            const prereleaseBlocked = version.versionType !== 'release' && !allowPrerelease
            const disabledReason = !compatibility.ok ? compatibility.reason : prereleaseBlocked ? '需要勾选允许测试版/内测版' : null
            return (
              <div className="catalog-version" key={version.id}>
                <div className="catalog-version__main">
                  <div className="catalog-version__title">
                    <strong>{version.name}</strong>
                    <Badge tone={version.versionType === 'release' ? 'success' : 'warning'}>{versionTypeLabel(version.versionType)}</Badge>
                    <span className="mono">{version.versionNumber}</span>
                  </div>
                  <div className="catalog-version__meta">
                    <span>{version.gameVersions.slice(0, 4).join(' / ')}</span>
                    <span>{version.loaders.map(loaderLabel).join(' / ')}</span>
                    <span>{formatDate(version.datePublished)}</span>
                    <span>{formatDownloads(version.downloads)} 下载</span>
                  </div>
                  {version.changelog ? (
                    <details className="catalog-version__changelog">
                      <summary>更新日志</summary>
                      <pre>{shortText(version.changelog, 1600)}</pre>
                    </details>
                  ) : null}
                  {disabledReason ? <div className="catalog-version__reason">{disabledReason}</div> : null}
                </div>
                <Button
                  size="sm"
                  variant={version.versionType === 'release' ? 'primary' : 'secondary'}
                  icon="download"
                  loading={installing === version.id}
                  disabled={Boolean(disabledReason) || Boolean(installing)}
                  title={disabledReason ?? '安装此版本'}
                  onClick={() => void install(version)}
                >
                  安装
                </Button>
              </div>
            )
          })}
        </div>
      ) : null}
    </Card>
  )
}

export function CatalogSearch({ instance, category }: { instance: InstanceSummary | null; category?: string }) {
  const isProjectType = (value: string | undefined): value is CatalogProjectType =>
    value === 'mod' || value === 'modpack' || value === 'resourcepack' || value === 'shader'
  const backend = useBackend()
  const [query, setQuery] = useState('')
  const [projectType, setProjectType] = useState<CatalogProjectType>(isProjectType(category) ? category : 'mod')
  const [loader, setLoader] = useState('')
  const [gameVersion, setGameVersion] = useState('')
  const [filters, setFilters] = useState<SearchFilters>({ query: '', projectType: 'mod', loaders: [], offset: 0 })
  const [selectedHit, setSelectedHit] = useState<CatalogSearchHit | null>(null)
  const [installing, setInstalling] = useState<string | null>(null)
  const [installed, setInstalled] = useState<CatalogInstallResult | null>(null)
  const [installError, setInstallError] = useState<UiErrorInfo | null>(null)
  const [installProgress, setInstallProgress] = useState<CatalogInstallProgressEvent | null>(null)
  const [cfSlug, setCfSlug] = useState('')
  const [cfBusy, setCfBusy] = useState(false)
  const [cfResult, setCfResult] = useState<CatalogPageResult | null>(null)
  const [cfError, setCfError] = useState<UiErrorInfo | null>(null)
  const [allowPrerelease, setAllowPrerelease] = useState(false)
  const search = useAsync(() => backend.catalog.search({ ...filters, limit: PAGE_SIZE }), [filters])
  // Real version list for the picker: releases first, then snapshots. A native
  // <select> scrolls reliably, unlike <datalist> in this shell.
  const manifest = useAsync(() => backend.downloads.manifest(), [])
  const versionGroups = useMemo(() => {
    const versions = manifest.data?.versions ?? []
    return {
      releases: versions.filter((version) => version.type === 'release').map((version) => version.id).slice(0, 160),
      snapshots: versions.filter((version) => version.type === 'snapshot').map((version) => version.id).slice(0, 120),
    }
  }, [manifest.data])

  // Follow the selected instance by default: searching for mods almost always
  // targets that instance's version, and typing it by hand invites typos.
  useEffect(() => {
    if (!instance?.mcVersion) return
    setGameVersion((current) => (current.trim() === '' ? instance.mcVersion ?? '' : current))
  }, [instance?.id, instance?.mcVersion])

  useEffect(() => {
    setSelectedHit(null)
    setInstalled(null)
    setInstallError(null)
    setInstallProgress(null)
    setInstalling(null)
  }, [instance?.id])

  useEffect(() => {
    const offProgress = backend.catalog.subscribeInstallProgress((event) => setInstallProgress(event))
    const offUpdated = backend.catalog.subscribeUpdated(() => {
      // Install progress already reports the file result; this keeps a future
      // update view refresh safe without inventing a success state.
    })
    return () => {
      offProgress()
      offUpdated()
    }
  }, [backend])

  const apply = (nextOffset = 0) => {
    setSelectedHit(null)
    setFilters({
      query: query.trim(),
      projectType,
      loaders: loader ? [loader] : [],
      ...(gameVersion.trim() ? { gameVersion: gameVersion.trim() } : {}),
      offset: nextOffset,
    })
  }

  const useInstanceFilters = () => {
    if (!instance) return
    if (instance.mcVersion) setGameVersion(instance.mcVersion)
    if (instance.loader.type !== 'vanilla' && instance.loader.type !== 'unknown') setLoader(instance.loader.type)
  }

  const installLatest = async (hit: CatalogSearchHit) => {
    if (!instance) return
    const compatibility = projectCompatibility(hit, instance)
    if (!compatibility.ok) {
      setInstallError({ kind: 'error', title: '不能安装', detail: compatibility.reason ?? '不兼容', retryable: false })
      return
    }
    setInstalling(hit.projectId)
    setInstallError(null)
    setInstalled(null)
    setInstallProgress(null)
    try {
      const result = await backend.catalog.install({ instanceId: instance.id, projectId: hit.projectId, allowPrerelease })
      setInstalled(result)
    } catch (cause) {
      setInstallError(describeError(cause))
    } finally {
      setInstalling(null)
    }
  }

  const openCurseForge = async () => {
    setCfBusy(true)
    setCfError(null)
    setCfResult(null)
    try {
      setCfResult(await backend.catalog.openPage({ provider: 'curseforge', slug: cfSlug.trim() }))
    } catch (cause) {
      setCfError(describeError(cause))
    } finally {
      setCfBusy(false)
    }
  }

  const total = search.data?.total ?? 0
  const offset = search.data?.offset ?? filters.offset
  const page = Math.floor(offset / PAGE_SIZE) + 1
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <>
      <div className="catalog-type-chips" role="tablist" aria-label="项目类型">
        {PROJECT_TYPE_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={projectType === option.value}
            className="catalog-type-chip"
            onClick={() => {
              // Each category is its own route: clicking a chip switches the
              // page, so the list always shows exactly one project type.
              setProjectType(option.value)
              setFilters({ query: '', projectType: option.value, loaders: [], gameVersion: undefined, offset: 0 })
              navigate(`/catalog/${option.value}`)
            }}
          >
            <Icon name={TYPE_ICONS[option.value] ?? 'package'} className="ico ico--sm" />
            <span>{option.label}</span>
          </button>
        ))}
      </div>
      <Card className="catalog-filters">
        <div className="catalog-filters__row catalog-filters__row--wide">
          <Field label="搜索关键词">
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') apply() }}
              placeholder="例如 sodium、fabric api、iris"
            />
          </Field>
        </div>
        <div className="catalog-filters__row catalog-filters__row--two">
          <Field label="游戏版本">
            <Dropdown
              value={gameVersion}
              placeholder="全部版本"
              onChange={setGameVersion}
              groups={[
                { options: [{ value: '', label: '全部版本' }] },
                { label: '正式版', options: versionGroups.releases.map((version) => ({ value: version, label: version })) },
                { label: '快照', options: versionGroups.snapshots.map((version) => ({ value: version, label: version })) },
              ]}
            />
          </Field>
          <Field label="加载器">
            <Dropdown
              value={loader}
              placeholder="全部加载器"
              onChange={setLoader}
              groups={[
                {
                  options: [
                    { value: '', label: '全部加载器' },
                    ...LOADER_OPTIONS.map((option) => ({ value: option.value, label: option.label })),
                  ],
                },
              ]}
            />
          </Field>
        </div>
        <div className="catalog-filters__actions">
          <Button size="sm" variant="secondary" icon="package" onClick={useInstanceFilters} disabled={!instance}>用当前实例筛选</Button>
          <label className="catalog-prerelease catalog-prerelease--filter">
            <input type="checkbox" checked={allowPrerelease} onChange={(event) => setAllowPrerelease(event.target.checked)} />
            <span>允许一键安装 beta / alpha（详情中仍可单独确认）</span>
          </label>
          <span className="toolbar__spacer" />
          <Button size="sm" variant="ghost" onClick={() => { setQuery(''); setProjectType('mod'); setLoader(''); setGameVersion(''); setFilters({ query: '', projectType: 'mod', loaders: [], offset: 0 }) }}>清空</Button>
          <Button size="sm" variant="primary" icon="search" onClick={() => apply()} loading={search.status === 'loading'}>搜索</Button>
        </div>
      </Card>

      {installError ? <div className="nw-inline-error">{installError.title}：{installError.detail}{installError.code ? `（${installError.code}）` : ''}</div> : null}
      {installed ? (
        <Banner tone="success" title={`已安装 ${installed.filename}`}>
          目标文件：<span className="mono">{installed.targetPath}</span>；{formatBytes(installed.size)}。
        </Banner>
      ) : null}
      {installProgress && installing ? (
        <div className="catalog-progress"><span className="muted">正在安装 {installProgress.versionId} · {installProgress.stage}</span><Progress value={installProgress.percent} label="资源安装进度" /></div>
      ) : null}

      {selectedHit ? <ProjectDetail key={selectedHit.projectId} hit={selectedHit} instance={instance} onClose={() => setSelectedHit(null)} /> : null}

      <Card className="catalog-results">
        <div className="catalog-results__head">
          <div>
            <h2>搜索结果</h2>
            <span>
              {search.data ? `${search.data.total} 个结果 · 第 ${page}/${pages} 页` : '正在读取 Modrinth'}
              {search.data?.cached ? ' · 缓存命中' : ''}
              {search.data?.source ? ` · ${search.data.source}` : ''}
            </span>
          </div>
          <Badge tone="outline">数据来自 mc:catalog:search</Badge>
        </div>
        {search.status === 'loading' ? (
          <div className="catalog-row-list">
            {Array.from({ length: 4 }, (_, index) => (
              <div className="catalog-row-skeleton" key={index}><Skeleton className="skeleton--title" style={{ width: '55%' }} /><Skeleton className="skeleton--text" style={{ marginTop: 12 }} /><Skeleton className="skeleton--text" style={{ width: '70%', marginTop: 8 }} /></div>
            ))}
          </div>
        ) : search.status === 'not-wired' || search.status === 'error' ? (
          <DataStateNotice info={describeError(search.error)} onRetry={search.reload} retryLabel="重新搜索" />
        ) : search.data?.hits.length === 0 ? (
          <EmptyState icon="search" title="没有找到项目" description="换一个关键词或清空筛选条件；结果只来自 Modrinth 实时 API。" />
        ) : (
          <div className="catalog-row-list" key={projectType}>
            {search.data?.hits.map((hit) => (
              <HitCard
                key={hit.projectId}
                hit={hit}
                instance={instance}
                installing={installing === hit.projectId}
                onOpen={() => setSelectedHit(hit)}
                onInstall={() => void installLatest(hit)}
              />
            ))}
          </div>
        )}
        <div className="catalog-pager">
          <Button size="sm" variant="secondary" icon="chevron-right" disabled={offset === 0 || search.status === 'loading'} onClick={() => apply(Math.max(0, offset - PAGE_SIZE))}>上一页</Button>
          <span>第 {page} / {pages} 页 · 共 {total} 项</span>
          <Button size="sm" variant="secondary" iconAfter="chevron-right" disabled={offset + PAGE_SIZE >= total || search.status === 'loading'} onClick={() => apply(offset + PAGE_SIZE)}>下一页</Button>
        </div>
      </Card>

      <Card className="catalog-cf">
        <div>
          <div className="catalog-cf__title"><Icon name="external" /><strong>CurseForge · 仅打开项目页</strong><Badge tone="outline">不调用 API</Badge></div>
          <p>CurseForge 没有配置 API key；本启动器不搜索、不下载、不代理 CurseForge 资源，只根据你输入的 slug 打开官网项目页。</p>
        </div>
        <div className="catalog-cf__form">
          <Input value={cfSlug} onChange={(event) => setCfSlug(event.target.value)} placeholder="项目 slug，例如 jei" aria-label="CurseForge 项目 slug" />
          <Button size="sm" variant="secondary" icon="external" disabled={!cfSlug.trim() || cfBusy} loading={cfBusy} onClick={() => void openCurseForge()}>打开项目页</Button>
        </div>
        {cfResult ? <Banner tone={cfResult.opened ? 'success' : 'info'}>{cfResult.opened ? `已在浏览器打开 ${cfResult.url}` : `项目页：${cfResult.url}`}</Banner> : null}
        {cfError ? <div className="nw-inline-error">{cfError.title}：{cfError.detail}</div> : null}
      </Card>
    </>
  )
}
