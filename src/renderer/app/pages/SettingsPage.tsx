import { useEffect, useState } from 'react'
import { useBackend } from '../data/BackendContext'
import { describeError } from '../data/backend'
import { useAsync } from '../data/useAsync'
import { useInstanceSelection } from '../data/useInstanceSelection'
import { useInstanceSettingsDraft } from '../data/useInstanceSettingsDraft'
import { useSystem } from '../system'
import { useTheme, type ThemeMode } from '../theme'
import { navigate, useRoute } from '../router'
import {
  Badge,
  Button,
  Card,
  DataStateNotice,
  EmptyState,
  Field,
  Input,
  PageHeader,
  PageNav,
  Segmented,
  Select,
  Switch,
} from '../ui'
import type { IconName } from '../icons'
import { InstancePicker } from './InstancePicker'
import { InstanceSettingsFields } from './InstanceSettingsFields'
import { AccountSettingsPanel } from './AccountSettingsPanel'
import { LinkSettingsPanel } from './LinkSettingsPanel'

type Section = 'account' | 'launch' | 'java' | 'download' | 'link' | 'appearance' | 'diagnostics'

/**
 * Physical memory versus what this instance may take, drawn from perf.hardware
 * (real numbers) and the draft's -Xmx field. No invented values: when hardware
 * cannot be read the bar degrades to a plain notice.
 */
function MemoryBar({ draft }: { draft: ReturnType<typeof useInstanceSettingsDraft> }) {
  const backend = useBackend()
  const hardware = useAsync(() => backend.perf.hardware(), [])
  const [optimizeBeforeLaunch, setOptimizeBeforeLaunch] = useState(() => {
    try {
      return window.localStorage.getItem('mcl.pref.optimizeBeforeLaunch') === '1'
    } catch {
      return false
    }
  })
  if (!draft) return null
  const totalGb = hardware.data?.totalMemBytes ? hardware.data.totalMemBytes / 1024 ** 3 : null
  const freeGb = hardware.data?.freeMemBytes ? hardware.data.freeMemBytes / 1024 ** 3 : null
  const usedGb = totalGb !== null && freeGb !== null ? Math.max(0, totalGb - freeGb) : null
  const assignedMb = Number(draft.maxMb)
  const assignedGb = Number.isFinite(assignedMb) && assignedMb > 0 ? assignedMb / 1024 : null
  if (totalGb === null) {
    return (
      <div className="memory-bar memory-bar--unknown">
        本机物理内存读取失败，无法绘制占用条；下面的内存设置仍然可用。
      </div>
    )
  }
  const usedPct = usedGb === null ? 0 : Math.min(100, (usedGb / totalGb) * 100)
  const assignedPct = assignedGb === null ? 0 : Math.min(100, (assignedGb / totalGb) * 100)
  return (
    <div className="memory-bar">
      <div className="memory-bar__head">
        <strong>内存分配</strong>
        <span className="memory-bar__mode">自定义 · 由下方「最大内存」决定</span>
      </div>
      <div className="memory-bar__track" role="img" aria-label={`已用 ${usedGb?.toFixed(1)} GB / ${totalGb.toFixed(1)} GB，游戏分配 ${assignedGb?.toFixed(1) ?? '—'} GB`}>
        <span className="memory-bar__used" style={{ width: `${usedPct}%` }} />
        <span className="memory-bar__game" style={{ width: `${assignedPct}%` }} />
      </div>
      <div className="memory-bar__legend">
        <span>已使用 <b>{usedGb?.toFixed(1) ?? '—'} GB</b> / {totalGb.toFixed(1)} GB</span>
        <span>游戏分配 <b>{assignedGb?.toFixed(1) ?? '—'} GB</b></span>
      </div>
      <label className="memory-bar__opt">
        <input
          type="checkbox"
          checked={optimizeBeforeLaunch}
          onChange={(event) => {
            setOptimizeBeforeLaunch(event.target.checked)
            try {
              window.localStorage.setItem('mcl.pref.optimizeBeforeLaunch', event.target.checked ? '1' : '0')
            } catch {
              /* storage unavailable: the choice still applies to this session */
            }
          }}
        />
        <span>启动游戏前进行内存优化（清理启动器缓存与崩溃转储，白名单内目录）</span>
      </label>
    </div>
  )
}

const SECTIONS: ReadonlyArray<{ value: Section; label: string; icon: IconName }> = [
  { value: 'account', label: '账户', icon: 'user' },
  { value: 'launch', label: '启动', icon: 'play' },
  { value: 'java', label: 'Java', icon: 'coffee' },
  { value: 'download', label: '下载', icon: 'download' },
  { value: 'link', label: '联机', icon: 'link' },
  { value: 'appearance', label: '外观', icon: 'sun' },
  { value: 'diagnostics', label: '日志与诊断', icon: 'terminal' },
]

const THEME_OPTIONS: ReadonlyArray<{ value: ThemeMode; label: string }> = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
]

function isSection(value: string | undefined): value is Section {
  return Boolean(value && SECTIONS.some((item) => item.value === value))
}

export function SettingsPage() {
  const backend = useBackend()
  const system = useSystem()
  const route = useRoute()
  const theme = useTheme()
  const download = useAsync(() => backend.downloads.settings(), [])
  const selection = useInstanceSelection()
  const draft = useInstanceSettingsDraft(selection.selected)
  const [section, setSection] = useState<Section>(isSection(route.section) ? route.section : 'launch')
  const [customUrl, setCustomUrl] = useState('')
  const [customDir, setCustomDir] = useState('')
  const [customName, setCustomName] = useState('')
  const [customBusy, setCustomBusy] = useState(false)
  const [customResult, setCustomResult] = useState<string | null>(null)
  const [customError, setCustomError] = useState<string | null>(null)

  const chooseCustomDir = async () => {
    // No folder picker in the preload bridge yet; typing the path is supported.
  }
  void chooseCustomDir

  const runCustomDownload = async () => {
    setCustomBusy(true)
    setCustomResult(null)
    setCustomError(null)
    try {
      const result = await backend.downloads.downloadCustomFile({
        url: customUrl.trim(),
        saveDir: customDir.trim(),
        ...(customName.trim() ? { fileName: customName.trim() } : {}),
      })
      setCustomResult(result.path)
    } catch (cause) {
      const info = describeError(cause)
      setCustomError(`${info.title}：${info.detail}`)
    } finally {
      setCustomBusy(false)
    }
  }
  const [reduceMotion, setReduceMotion] = useState(false)

  useEffect(() => {
    if (isSection(route.section) && route.section !== section) setSection(route.section)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.section])

  const choose = (next: Section) => {
    setSection(next)
    navigate(`/settings/${next}`)
  }

  const downloadPending = download.status === 'not-wired' || download.status === 'error'
  const downloadInfo = downloadPending ? describeError(download.error) : null

  const toggleMotion = (next: boolean) => {
    setReduceMotion(next)
    document.documentElement.classList.toggle('no-motion', next)
  }

  const instanceSection = section === 'launch' || section === 'java'

  return (
    <>
      <PageHeader
        title="设置"
        subtitle="实例内存/窗口/JVM/Java 通过 instance.update 写入 instance.json；账户通过 auth 模块。保存后直接刷新 launch dry-run。"
        actions={<Badge tone="success" dot>真实 IPC</Badge>}
      />

      {instanceSection ? (
        <InstancePicker
          selection={selection}
          onRefresh={selection.instances.reload}
          hint="内存、窗口、JVM 参数和 Java 选择只作用于当前实例；保存后用真实 launch plan 验证。"
          badge="实例设置"
        />
      ) : null}

      <div className="page-split">
        <PageNav
          label="设置分区"
          active={section}
          onChange={(key) => choose(key as Section)}
          items={SECTIONS.map((item) => ({ key: item.value, label: item.label, icon: item.icon }))}
        />

        <Card className="settings-content" pad={false}>
          <div className="settings-panel is-active">
            {section === 'account' ? <AccountSettingsPanel /> : null}

            {section === 'launch' ? (
              <div className="settings-section">
                <div className="settings-section__head">
                  <div><h2>启动</h2><p>内存、窗口、JVM 参数与 Java 选择均写入实例；下方 dry-run 来自真实 launch.plan。</p></div>
                </div>
                <div className="settings-section__body">
                  {draft ? <MemoryBar draft={draft} /> : null}
                  {draft ? <InstanceSettingsFields draft={draft} mode="all" /> : (
                    <EmptyState icon="instances" title="先选择实例" description="没有实例时不会显示或伪造内存、窗口、JVM 参数。" />
                  )}
                </div>
              </div>
            ) : null}

            {section === 'java' ? (
              <div className="settings-section">
                <div className="settings-section__head">
                  <div><h2>Java</h2><p>候选来自 java.detect；实例级覆盖优先于全局/自动选择，保存后用 dry-run 验证。</p></div>
                </div>
                <div className="settings-section__body">
                  {draft ? <InstanceSettingsFields draft={draft} mode="java" /> : (
                    <EmptyState icon="coffee" title="先选择实例" description="Java 选择需要实例目标；没有实例时不伪造路径。" />
                  )}
                </div>
              </div>
            ) : null}

            {section === 'download' ? (
              <div className="settings-section">
                <div className="settings-section__head"><div><h2>下载</h2><p>下载源、并发与镜像来自 download 模块；无法读取时显示明确状态。</p></div></div>
                <div className="settings-section__body">
                  {downloadInfo ? <DataStateNotice info={downloadInfo} onRetry={download.reload} /> : null}
                  <div className="setting-group">
                    <div className="setting-group__text"><div className="setting-group__title">下载源</div><div className="setting-group__desc">{download.data ? `实际来源：${download.data.sourcePreference}` : '自动测速/BMCLAPI/官方源由下载模块决定。'}</div></div>
                    <div className="setting-control">
                      <Select
                        aria-label="下载源"
                        value={download.data?.sourcePreference ?? 'auto'}
                        disabled={download.status !== 'ready'}
                        onChange={(event) => {
                          const sourcePreference = event.target.value as 'auto' | 'official' | 'mirror'
                          void backend.downloads.updateSettings({ sourcePreference }).then(download.reload).catch(() => undefined)
                        }}
                      >
                        <option value="auto">自动</option>
                        <option value="official">官方源</option>
                        <option value="mirror">镜像源</option>
                      </Select>
                    </div>
                  </div>
                  <div className="setting-group">
                    <div className="setting-group__text"><div className="setting-group__title">并发下载数</div><div className="setting-group__desc">来自 download.getSettings，范围 1–16。</div></div>
                    <div className="setting-control"><Input value={download.data?.concurrency ?? '—'} readOnly disabled={download.status !== 'ready'} aria-label="并发下载数" /></div>
                  </div>
                  <div className="setting-group">
                    <div className="setting-group__text"><div className="setting-group__title">镜像源</div><div className="setting-group__desc">关闭后仅使用官方源（合规模式）。</div></div>
                    <div className="setting-control">
                      <Switch
                        checked={download.data?.mirrorEnabled ?? false}
                        onChange={(mirrorEnabled) => void backend.downloads.updateSettings({ mirrorEnabled }).then(download.reload).catch(() => undefined)}
                        label="镜像源"
                        disabled={download.status !== 'ready'}
                      />
                    </div>
                  </div>
                  <div className="setting-group">
                    <div className="setting-group__text"><div className="setting-group__title">缓存</div><div className="setting-group__desc">缓存路径来自数据根；清理需要 download 后端。</div></div>
                    <div className="setting-control"><Button size="sm" variant="secondary" icon="folder" onClick={() => void backend.system.openDataDir()}>打开数据目录</Button></div>
                  </div>
                  <div className="setting-group setting-group--stack">
                    <div className="setting-group__text">
                      <div className="setting-group__title">下载自定义文件</div>
                      <div className="setting-group__desc">任意 https 链接直接流式写入指定目录；只接受 https，写入时使用 .part 再改名。</div>
                    </div>
                    <div className="custom-download">
                      <Field label="下载地址">
                        <Input value={customUrl} onChange={(event) => setCustomUrl(event.target.value)} placeholder="https://example.com/file.zip" />
                      </Field>
                      <Field label="保存到">
                        <Input value={customDir} onChange={(event) => setCustomDir(event.target.value)} placeholder="D:\\下载" />
                      </Field>
                      <Field label="文件名" hint="留空则使用链接中的文件名">
                        <Input value={customName} onChange={(event) => setCustomName(event.target.value)} placeholder="可选" />
                      </Field>
                      <div className="custom-download__actions">
                        <Button variant="primary" loading={customBusy} disabled={customBusy || !customUrl.trim() || !customDir.trim()} onClick={() => void runCustomDownload()}>
                          开始下载
                        </Button>
                        <Button variant="secondary" icon="folder" onClick={() => void backend.system.openDataDir()}>打开数据目录</Button>
                        {customResult ? <span className="instance-settings-card__saved">已保存：<code className="mono">{customResult}</code></span> : null}
                        {customError ? <span className="instance-settings-card__error">{customError}</span> : null}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            ) : null}

            {section === 'link' ? <LinkSettingsPanel /> : null}

            {section === 'appearance' ? (
              <div className="settings-section">
                <div className="settings-section__head"><div><h2>外观</h2><p>主题是渲染层本地设置，可立即生效并记忆；其他外观项等待持久化。</p></div></div>
                <div className="settings-section__body">
                  <div className="setting-group">
                    <div className="setting-group__text"><div className="setting-group__title">主题</div><div className="setting-group__desc">跟随系统或强制浅色/深色；写入 localStorage，重启界面后保留。</div></div>
                    <div className="setting-control">
                      <Segmented value={theme.mode} options={THEME_OPTIONS} onChange={theme.setMode} ariaLabel="主题" />
                    </div>
                  </div>
                  <div className="setting-group">
                    <div className="setting-group__text"><div className="setting-group__title">减少动效</div><div className="setting-group__desc">关闭装饰性动画；当前只影响本机渲染层。</div></div>
                    <div className="setting-control"><Switch checked={reduceMotion} onChange={toggleMotion} label="减少动效" /></div>
                  </div>
                  <div className="setting-group">
                    <div className="setting-group__text"><div className="setting-group__title">语言</div><div className="setting-group__desc">P0 仅支持简体中文；语言切换需要 i18n 框架。</div></div>
                    <div className="setting-control"><Select disabled defaultValue="zh-CN" aria-label="语言"><option value="zh-CN">简体中文</option></Select></div>
                  </div>
                  <div className="setting-group">
                    <div className="setting-group__text"><div className="setting-group__title">强调色</div><div className="setting-group__desc">Verdant 品牌色；P1 再开放自定义。</div></div>
                    <div className="setting-control"><div className="accent-swatches"><span className="accent-swatch is-active"><i style={{ background: 'var(--accent)' }} />Verdant</span><span className="accent-swatch">P1</span></div></div>
                  </div>
                </div>
              </div>
            ) : null}

            {section === 'diagnostics' ? (
              <div className="settings-section">
                <div className="settings-section__head"><div><h2>日志与诊断</h2><p>数据目录和日志文件来自真实 system.info；日志页提供来源过滤、导出日志与诊断包。</p></div></div>
                <div className="settings-section__body">
                  <div className="setting-group">
                    <div className="setting-group__text"><div className="setting-group__title">数据目录</div><div className="setting-group__desc mono">{system.info?.dataRoot ?? '等待 system.info'}</div></div>
                    <div className="setting-control"><Button size="sm" variant="secondary" icon="folder" onClick={() => void backend.system.openDataDir()}>打开目录</Button></div>
                  </div>
                  <div className="setting-group">
                    <div className="setting-group__text"><div className="setting-group__title">日志文件</div><div className="setting-group__desc mono">{system.info?.logFile ?? '等待 system.info'}</div></div>
                    <div className="setting-control"><Badge tone="outline">真实路径</Badge></div>
                  </div>
                  <div className="setting-group">
                    <div className="setting-group__text"><div className="setting-group__title">日志与诊断</div><div className="setting-group__desc">在日志页查看实时/历史日志、按来源/级别筛选，并导出诊断包。</div></div>
                    <div className="setting-control"><Button size="sm" variant="secondary" icon="terminal" onClick={() => navigate('/logs')}>打开日志页</Button></div>
                  </div>
                </div>
              </div>
            ) : null}
          </div>

          <div className="settings-savebar">
            <span>实例设置写入 instance.json；账户写入 auth；主题/下载各有真实或本地来源。</span>
            <Button size="xs" variant="ghost" onClick={() => navigate('/logs')}>查看日志</Button>
          </div>
        </Card>
      </div>
    </>
  )
}
