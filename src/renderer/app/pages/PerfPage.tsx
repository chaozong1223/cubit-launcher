import { useEffect, useState } from 'react'
import type { MemoryRecommendation, PerfCacheScan } from '@shared/perf'
import { useBackend } from '../data/BackendContext'
import { describeError, type UiErrorInfo } from '../data/backend'
import { useAsync } from '../data/useAsync'
import { useInstanceSelection } from '../data/useInstanceSelection'
import {
  Badge,
  Banner,
  Button,
  Card,
  DataStateNotice,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Select,
  Skeleton,
} from '../ui'
import { Icon } from '../icons'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

function formatRam(bytes: number | null): string {
  if (bytes === null) return '未知'
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

export function PerfPage() {
  const backend = useBackend()
  const selection = useInstanceSelection()
  const hardware = useAsync(() => backend.perf.hardware(), [])
  const processes = useAsync(() => backend.perf.processes(), [])
  const [cache, setCache] = useState<PerfCacheScan | null>(null)
  const [cacheState, setCacheState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [cacheError, setCacheError] = useState<UiErrorInfo | null>(null)
  const [chosenCategories, setChosenCategories] = useState<Set<string>>(new Set())
  const [recommendation, setRecommendation] = useState<MemoryRecommendation | null>(null)
  const [recommendError, setRecommendError] = useState<UiErrorInfo | null>(null)
  const [customMb, setCustomMb] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ tone: 'success' | 'warning' | 'danger'; title: string; detail: string } | null>(null)

  const selectedId = selection.selected?.id ?? ''

  const scanCache = async () => {
    setCacheState('loading')
    setCacheError(null)
    try {
      const result = await backend.perf.scanCache()
      setCache(result)
      setChosenCategories(new Set(result.categories.filter((entry) => entry.present).map((entry) => entry.id)))
      setCacheState('ready')
    } catch (error) {
      setCacheError(describeError(error))
      setCacheState('error')
    }
  }

  useEffect(() => {
    void scanCache()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend])

  useEffect(() => {
    setRecommendation(null)
    setRecommendError(null)
    setCustomMb('')
    if (!selectedId) return
    let alive = true
    backend.perf.recommend({ instanceId: selectedId }).then(
      (result) => {
        if (!alive) return
        setRecommendation(result)
        setCustomMb(String(result.recommendedMb))
      },
      (error: unknown) => {
        if (alive) setRecommendError(describeError(error))
      },
    )
    return () => {
      alive = false
    }
  }, [backend, selectedId])

  const apply = async (mb?: number) => {
    if (!selectedId) return
    setBusy('apply')
    setNotice(null)
    try {
      const result = await backend.perf.apply({ instanceId: selectedId, ...(mb ? { mb } : {}) })
      setNotice({
        tone: 'success',
        title: `已应用 ${result.mb} MB`,
        detail: result.appliesNextLaunch
          ? '实例正在运行：当前进程仍使用旧堆大小，下次启动生效。'
          : `内存模式已设为自定义；之前为 ${result.previousMb === null ? '自动' : `${result.previousMb} MB`}。`,
      })
    } catch (error) {
      const info = describeError(error)
      setNotice({ tone: 'danger', title: info.title, detail: info.detail })
    } finally {
      setBusy(null)
    }
  }

  const clean = async () => {
    if (!cache) return
    setBusy('clean')
    setNotice(null)
    try {
      const categories = [...chosenCategories]
      const result = await backend.perf.cleanCache(categories.length > 0 ? { categories } : {})
      setNotice({
        tone: result.errors.length > 0 ? 'warning' : 'success',
        title: `已清理 ${result.removedFiles} 个文件`,
        detail: `${formatBytes(result.removedBytes)}${result.errors.length > 0 ? `；${result.errors.length} 项失败：${result.errors.join('；')}` : ''}`,
      })
      await scanCache()
    } catch (error) {
      const info = describeError(error)
      setNotice({ tone: 'danger', title: info.title, detail: info.detail })
    } finally {
      setBusy(null)
    }
  }

  const hardwareData = hardware.data
  const processData = processes.data
  const chosenCache = cache
    ? cache.categories.filter((entry) => chosenCategories.has(entry.id) && entry.present)
    : []

  return (
    <>
      <PageHeader
        title="内存与性能"
        subtitle="硬件探测、按 mod 数推荐 -Xmx、游戏进程占用与白名单缓存清理。所有数字来自本机探测；读不到时显示“未知”，不编造。"
        actions={
          <Button
            variant="secondary"
            icon="refresh"
            loading={hardware.status === 'loading'}
            onClick={() => {
              hardware.reload()
              processes.reload()
            }}
          >
            重新探测
          </Button>
        }
      />

      {notice ? (
        <Banner tone={notice.tone} title={notice.title}>
          {notice.detail}
        </Banner>
      ) : null}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
        <Card>
          <div className="row gap-8" style={{ marginBottom: 12 }}>
            <Icon name="memory" />
            <strong>硬件信息</strong>
            <Badge tone={hardwareData?.totalMemBytes ? 'accent' : 'warning'}>
              {hardwareData?.totalMemBytes ? '已探测' : '部分未知'}
            </Badge>
          </div>
          {hardware.status === 'loading' ? (
            <div className="nw-stack"><Skeleton className="skeleton--text" style={{ width: '70%' }} /><Skeleton className="skeleton--text" style={{ width: '45%' }} /></div>
          ) : hardware.status !== 'ready' ? (
            <DataStateNotice info={describeError(hardware.error)} onRetry={hardware.reload} />
          ) : (
            <div className="nw-stack" style={{ gap: 8 }}>
              <div className="row" style={{ justifyContent: 'space-between' }}><span className="muted">CPU</span><span>{hardwareData?.cpuModel ?? '未知'}</span></div>
              <div className="row" style={{ justifyContent: 'space-between' }}><span className="muted">核心 / 架构</span><span>{hardwareData?.cpuCores ?? '未知'} 核 · {hardwareData?.arch ?? '未知'}</span></div>
              <div className="row" style={{ justifyContent: 'space-between' }}><span className="muted">物理内存</span><span>{formatRam(hardwareData?.totalMemBytes ?? null)}</span></div>
              <div className="row" style={{ justifyContent: 'space-between' }}><span className="muted">当前可用</span><span>{formatRam(hardwareData?.freeMemBytes ?? null)}</span></div>
              <div className="row" style={{ justifyContent: 'space-between' }}><span className="muted">系统</span><span>{hardwareData?.platform ?? '未知'}</span></div>
              {(hardwareData?.warnings.length ?? 0) > 0 ? (
                <p className="muted">{hardwareData!.warnings.join('；')}</p>
              ) : null}
            </div>
          )}
        </Card>

        <Card>
          <div className="row gap-8" style={{ marginBottom: 12 }}>
            <Icon name="activity" />
            <strong>按 mod 数推荐 -Xmx</strong>
            {recommendation ? <Badge tone="outline">{recommendation.modCount} 个 mod</Badge> : null}
          </div>
          <Field label="目标实例">
            <Select
              value={selectedId}
              onChange={(event) => selection.setSelectedId(event.target.value)}
              disabled={selection.instances.status !== 'ready'}
            >
              {(selection.instances.data ?? []).map((instance) => (
                <option key={instance.id} value={instance.id}>{instance.name} · {instance.mcVersion ?? '版本未知'}</option>
              ))}
            </Select>
          </Field>
          {recommendError ? <DataStateNotice info={recommendError} /> : null}
          {!selectedId ? <EmptyState icon="instances" title="没有可应用的实例" description="先创建或导入一个实例，再计算推荐内存。" /> : null}
          {selectedId && !recommendation && !recommendError ? <Skeleton className="skeleton--text" style={{ width: '65%' }} /> : null}
          {recommendation ? (
            <div className="nw-stack" style={{ gap: 10 }}>
              <div style={{ fontSize: 30, fontWeight: 700 }}>{recommendation.recommendedMb} MB</div>
              <p className="muted" style={{ margin: 0 }}>
                基础 {recommendation.baseMb} MB（25% 内存，限制在 2048–8192）+ 每满 50 个 mod 加 512 MB（本次 +{recommendation.bonusMb} MB）；上限 75% = {recommendation.capMb} MB。
              </p>
              {recommendation.clamped ? <Badge tone="warning">已按 75% 上限下调</Badge> : null}
              {recommendation.running ? <Badge tone="warning">实例运行中 · 下次启动生效</Badge> : null}
              {recommendation.warnings.map((warning) => <p key={warning} className="muted" style={{ margin: 0 }}>{warning}</p>)}
              <div className="row gap-8">
                <Input
                  type="number"
                  min={512}
                  max={65536}
                  value={customMb}
                  onChange={(event) => setCustomMb(event.target.value)}
                  aria-label="自定义 -Xmx（MB）"
                  style={{ width: 130 }}
                />
                <Button variant="primary" icon="check" loading={busy === 'apply'} onClick={() => void apply(Number(customMb) || undefined)}>应用到实例</Button>
                <Button variant="secondary" loading={busy === 'apply'} onClick={() => void apply(recommendation.recommendedMb)}>使用推荐值</Button>
              </div>
            </div>
          ) : null}
        </Card>
      </div>

      <Card>
        <div className="row gap-8" style={{ marginBottom: 12 }}>
          <Icon name="activity" />
          <strong>游戏进程占用</strong>
          <Badge tone="outline">tasklist</Badge>
          <Button size="xs" variant="secondary" icon="refresh" loading={processes.status === 'loading'} onClick={() => processes.reload()}>刷新</Button>
        </div>
        {processes.status === 'loading' ? <Skeleton className="skeleton--text" style={{ width: '55%' }} /> : null}
        {processes.status === 'error' || processes.status === 'not-wired' ? <DataStateNotice info={describeError(processes.error)} onRetry={processes.reload} /> : null}
        {processData && !processData.supported ? <Banner tone="info" title="当前系统不支持">{processData.error ?? '只有 Windows 支持 tasklist 读取。'}</Banner> : null}
        {processData?.supported && processData.error ? <Banner tone="warning" title="读取失败">{processData.error}；可稍后刷新重试。</Banner> : null}
        {processData?.supported && !processData.error ? (
          processData.processes.length === 0 ? (
            <EmptyState icon="activity" title="没有 Java 游戏进程" description="启动游戏后，这里会显示 javaw.exe / java.exe 的内存占用。" />
          ) : (
            <table className="table asset-table">
              <thead><tr><th>进程</th><th>PID</th><th className="num">内存占用</th></tr></thead>
              <tbody>
                {processData.processes.map((entry) => (
                  <tr key={entry.pid}><td className="mono">{entry.name}</td><td className="mono">{entry.pid}</td><td className="num">{formatBytes(entry.memBytes)}</td></tr>
                ))}
              </tbody>
            </table>
          )
        ) : null}
      </Card>

      <Card>
        <div className="row gap-8" style={{ marginBottom: 12 }}>
          <Icon name="package" />
          <strong>缓存清理（白名单）</strong>
          <Button size="xs" variant="secondary" icon="refresh" loading={cacheState === 'loading'} onClick={() => void scanCache()}>重新扫描</Button>
          <Button size="xs" variant="danger" icon="trash" loading={busy === 'clean'} disabled={chosenCache.length === 0} onClick={() => void clean()}>清理所选（{chosenCache.length}）</Button>
        </div>
        <p className="muted" style={{ marginTop: 0 }}>
          只统计并清理启动器缓存、崩溃转储、下载缓存和整合包下载缓存；不会碰存档、截图、日志、实例或任何用户游戏目录。先扫描（dry-run）确认数字，再手动清理。
        </p>
        {cacheError ? <DataStateNotice info={cacheError} onRetry={() => void scanCache()} /> : null}
        {cacheState === 'loading' ? <Skeleton className="skeleton--text" style={{ width: '60%' }} /> : null}
        {cache?.categories.length ? (
          <table className="table asset-table">
            <thead><tr><th style={{ width: 40 }} aria-label="选择" /><th>类别</th><th>路径</th><th className="num">文件</th><th className="num">大小</th></tr></thead>
            <tbody>
              {cache.categories.map((entry) => (
                <tr key={entry.id} className={entry.present ? undefined : 'is-disabled'}>
                  <td>
                    <input
                      type="checkbox"
                      checked={chosenCategories.has(entry.id)}
                      disabled={!entry.present}
                      aria-label={`选择 ${entry.label}`}
                      onChange={(event) => {
                        const next = new Set(chosenCategories)
                        if (event.target.checked) next.add(entry.id)
                        else next.delete(entry.id)
                        setChosenCategories(next)
                      }}
                    />
                  </td>
                  <td><strong>{entry.label}</strong>{entry.present ? null : <Badge tone="neutral">不存在</Badge>}</td>
                  <td className="mono" title={entry.path}>{entry.path}</td>
                  <td className="num">{entry.files}</td>
                  <td className="num">{formatBytes(entry.bytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        {cache ? <p className="muted" style={{ marginBottom: 0 }}>合计 {cache.totalFiles} 个文件 · {formatBytes(cache.totalBytes)}（{new Date(cache.generatedAt).toLocaleString('zh-CN', { hour12: false })} 扫描）</p> : null}
      </Card>
    </>
  )
}
