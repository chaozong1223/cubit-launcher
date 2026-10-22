import { useEffect, useState, type ReactNode } from 'react'
import noticeText from '../../../../NOTICE?raw'
import { useBackend } from '../data/BackendContext'
import { describeError } from '../data/backend'
import { useSystem } from '../system'
import { useTheme } from '../theme'
import { navigate } from '../router'
import { Badge, Banner, Button, Card, PageHeader, Skeleton } from '../ui'
import { Icon, CubeMark } from '../icons'

function noticeSection(text: string, heading: string): string {
  const marker = `### ${heading}`
  const start = text.indexOf(marker)
  if (start < 0) return ''
  const rest = text.slice(start + marker.length)
  const next = rest.indexOf('\n### ')
  return (next >= 0 ? rest.slice(0, next) : rest).trim()
}

const projectNotice = noticeText.split(/^### /m)[0].trim()
const hmclNotice = noticeSection(noticeText, 'HMCL (ported account code)')
const hmclCopyright = hmclNotice
  .split(/\r?\n/)
  .find((line) => line.includes('Copyright (C) 2020–2026 huangyuhui and HMCL contributors'))
  ?.replace(/^-\s*/, '')
  .trim() ?? ''
const easytierNotice = noticeSection(noticeText, 'EasyTier (optional LAN/tunnel sidecar)')
const modrinthNotice = noticeSection(noticeText, 'Modrinth')
const hmclUrl = hmclNotice.match(/https:\/\/github\.com\/HMCL-dev\/HMCL/)?.[0] ?? 'https://github.com/HMCL-dev/HMCL'
const easytierUrl = easytierNotice.match(/https:\/\/github\.com\/EasyTier\/EasyTier/)?.[0] ?? 'https://github.com/EasyTier/EasyTier'
const modrinthUrl = modrinthNotice.match(/https:\/\/modrinth\.com[^\s)]*/)?.[0] ?? 'https://modrinth.com'

function NoticeBlock({ text }: { text: string }) {
  return <pre className="about-notice-block" tabIndex={0}>{text}</pre>
}

function LicenseLink({ href, children }: { href: string; children: ReactNode }) {
  return <a className="about-license-link" href={href} target="_blank" rel="noreferrer">{children}<Icon name="external" /></a>
}

export function AboutPage() {
  const backend = useBackend()
  const system = useSystem()
  const theme = useTheme()
  const info = system.info
  const [noticeOpen, setNoticeOpen] = useState(false)

  useEffect(() => {
    if (!noticeOpen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setNoticeOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [noticeOpen])

  const downloadNotice = () => {
    const blob = new Blob([noticeText], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'NOTICE'
    anchor.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return (
    <>
      <PageHeader
        title="关于"
        subtitle="版本、运行环境、数据目录与安全边界均来自真实 IPC；更新/账户等未接入项会明确标注。"
        actions={<Button variant="secondary" icon="refresh" onClick={system.reload} disabled={system.loading}>刷新系统信息</Button>}
      />

      {system.error ? (
        <Banner tone="danger" title="系统信息读取失败" actions={<Button size="sm" variant="secondary" onClick={system.reload}>重试</Button>}>
          {describeError(system.error).detail}
        </Banner>
      ) : null}

      <div className="card about-hero">
        <span className="about-mark" aria-hidden="true"><CubeMark /></span>
        <div className="about-hero__text">
          <h1>Cubit Launcher</h1>
          <div className="about-hero__meta">
            {info ? <><span>v{info.version}</span><span>·</span><span>{info.platform} · {info.arch}</span><Badge tone="outline">t22 视觉预览</Badge></> : <Skeleton className="skeleton--text" style={{ width: 220 }} />}
          </div>
          <p className="page-sub" style={{ marginTop: 6 }}>克制、可解释的 Minecraft 启动器。渲染层现在按设计稿落地；数据接入按模块逐步收口。</p>
        </div>
        <div className="about-hero__actions">
          <Button variant="secondary" icon="folder" onClick={() => void backend.system.openDataDir()}>数据目录</Button>
          <Button variant="ghost" icon="flask" onClick={() => navigate('/components')}>界面规范</Button>
        </div>
      </div>

      <div className="about-grid">
        <Card className="about-card">
          <h2>更新</h2>
          <p>更新器尚未接入；不会伪造版本检查结果。</p>
          <div className="info-list">
            <div className="kv"><span className="kv__k">当前版本</span><span className="kv__v mono">{info?.version ?? '—'}</span></div>
            <div className="kv"><span className="kv__k">更新通道</span><span className="kv__v">等待 updater 模块</span></div>
            <div className="kv"><span className="kv__k">状态</span><span className="kv__v"><Badge tone="warning">尚未接入</Badge></span></div>
          </div>
          <div className="row gap-8" style={{ marginTop: 10 }}>
            <Button size="sm" variant="secondary" icon="refresh" disabled>检查更新</Button>
            <Button size="sm" variant="ghost" disabled>切换通道</Button>
          </div>
        </Card>

        <Card className="about-card">
          <h2>运行环境</h2>
          <p>直接来自 <code className="mono">mc:system:info</code>。</p>
          {system.loading ? (
            <div className="nw-stack"><Skeleton className="skeleton--text" /><Skeleton className="skeleton--text" style={{ width: '70%' }} /></div>
          ) : (
            <div className="info-list">
              <div className="kv"><span className="kv__k">Electron</span><span className="kv__v mono">{info?.electron ?? '—'}</span></div>
              <div className="kv"><span className="kv__k">Chromium</span><span className="kv__v mono">{info?.chrome ?? '—'}</span></div>
              <div className="kv"><span className="kv__k">Node</span><span className="kv__v mono">{info?.node ?? '—'}</span></div>
              <div className="kv"><span className="kv__k">平台</span><span className="kv__v">{info ? `${info.platform} · ${info.arch}` : '—'}</span></div>
              <div className="kv"><span className="kv__k">主题</span><span className="kv__v">{theme.mode} · {theme.resolved}</span></div>
            </div>
          )}
        </Card>

        <Card className="about-card">
          <h2>数据目录</h2>
          <p>配置、日志与 Chromium 数据共用一个 dataRoot；路径来自主进程。</p>
          <div className="path-row"><Icon name="folder" /><span title={info?.dataRoot}>{info?.dataRoot ?? '等待 system.info'}</span></div>
          <div className="path-row"><Icon name="terminal" /><span title={info?.logFile}>{info?.logFile ?? '等待日志路径'}</span></div>
          <div className="row gap-8" style={{ marginTop: 10 }}>
            <Button size="sm" variant="secondary" icon="folder" onClick={() => void backend.system.openDataDir()}>打开目录</Button>
            <Button size="sm" variant="ghost" icon="external" disabled title="剪贴板/文件通道尚未接入">打开日志文件</Button>
          </div>
        </Card>

        <Card className="about-card">
          <h2>模块与安全</h2>
          <p>这里的模块来自真实注册表；通道是否放行由 preload 决定。</p>
          <div className="info-list">
            <div className="kv"><span className="kv__k">已注册模块</span><span className="kv__v">{info?.modules.join(' · ') || '—'}</span></div>
            <div className="kv"><span className="kv__k">失败模块</span><span className="kv__v">{info?.failedModules.length ? info.failedModules.join(' · ') : '无'}</span></div>
            <div className="kv"><span className="kv__k">contextIsolation</span><span className="kv__v">{info?.security.contextIsolation ? 'true' : '—'}</span></div>
            <div className="kv"><span className="kv__k">nodeIntegration</span><span className="kv__v">{info ? String(info.security.nodeIntegration) : '—'}</span></div>
            <div className="kv"><span className="kv__k">sandbox</span><span className="kv__v">{info ? String(info.security.sandbox) : '—'}</span></div>
            <div className="kv"><span className="kv__k">白名单外通道</span><span className="kv__v">{system.flags.blockedChannelRejected === true ? '已拒绝' : '—'}</span></div>
            <div className="kv"><span className="kv__k">window.require</span><span className="kv__v">{system.flags.nodeRequire ? '已暴露（异常）' : '未暴露'}</span></div>
            <div className="kv"><span className="kv__k">window.process</span><span className="kv__v">{system.flags.nodeProcess ? '已暴露（异常）' : '未暴露'}</span></div>
          </div>
        </Card>
      </div>

      <Card className="about-license-card">
        <div className="about-license-head">
          <div>
            <div className="eyebrow">Open source licenses</div>
            <h2>开源许可</h2>
            <p>以下内容直接来自仓库根 <code className="mono">NOTICE</code>（构建时内联，同一份文案来源）；本页不维护第二套声明。</p>
          </div>
          <Badge tone="accent">GPL-3.0</Badge>
        </div>

        <div className="about-license-grid">
          <section className="about-license-section">
            <h3>本项目 · GPL-3.0</h3>
            <NoticeBlock text={projectNotice} />
          </section>
          <section className="about-license-section">
            <h3>HMCL 移植代码 · GPL-3.0</h3>
            <p className="about-license-source">
              来源：<LicenseLink href={hmclUrl}>HMCL-dev/HMCL</LicenseLink>
              <span className="muted"> · 版权与 GPL-3.0 声明见下方 NOTICE 原文</span>
            </p>
            {hmclCopyright ? <p className="about-license-copyright">{hmclCopyright}</p> : null}
            <NoticeBlock text={hmclNotice} />
          </section>
          <section className="about-license-section">
            <h3>EasyTier · LGPL-3.0</h3>
            <p className="about-license-source">
              来源：<LicenseLink href={easytierUrl}>EasyTier/EasyTier</LicenseLink>
              <span className="muted"> · 独立进程，运行时下载，不修改、不静态链接</span>
            </p>
            <NoticeBlock text={easytierNotice} />
          </section>
          <section className="about-license-section">
            <h3>Modrinth · 数据与服务声明</h3>
            <p className="about-license-source">
              来源：<LicenseLink href={modrinthUrl}>modrinth.com</LicenseLink>
              <span className="muted"> · 仅使用公开 API，不转存资源</span>
            </p>
            <NoticeBlock text={modrinthNotice} />
          </section>
        </div>

        <div className="about-license-actions">
          <Button variant="primary" icon="info" onClick={() => setNoticeOpen(true)}>查看完整 NOTICE</Button>
          <Button variant="secondary" icon="download" onClick={downloadNotice}>下载 NOTICE</Button>
          <span className="muted">完整文本可滚动查看；下载后可随源码/二进制保留。</span>
        </div>
      </Card>

      {noticeOpen ? (
        <div
          className="about-notice-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setNoticeOpen(false)
          }}
        >
          <div className="about-notice-modal" role="dialog" aria-modal="true" aria-labelledby="about-notice-title">
            <div className="about-notice-modal__head">
              <div>
                <div className="eyebrow">Repository notice</div>
                <h2 id="about-notice-title">完整 NOTICE</h2>
              </div>
              <Button size="sm" variant="ghost" icon="close" aria-label="关闭完整 NOTICE" onClick={() => setNoticeOpen(false)} />
            </div>
            <pre className="about-notice-full" tabIndex={0}>{noticeText}</pre>
            <div className="about-notice-modal__actions">
              <Button size="sm" variant="secondary" icon="download" onClick={downloadNotice}>下载 NOTICE</Button>
              <Button size="sm" variant="primary" icon="close" onClick={() => setNoticeOpen(false)}>关闭</Button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="legal-note" style={{ marginTop: 14 }}>
        本项目与 Mojang Studios、Microsoft 无关。Minecraft 是 Mojang Studios 的商标。启动器仅支持正版登录；离线账户仅用于单机或 online-mode=false 的自建服务器。代码采用 clean-room 实现，未读取或移植 PCL2 源码。
      </div>

      <button className="design-link-card" type="button" onClick={() => navigate('/components')}>
        <Icon name="flask" />
        <div style={{ flex: 1 }}>
          <strong>界面规范与组件预览</strong>
          <span>色板、字阶、按钮、启动 6 态、下载/联机状态机与错误文案；明确标注为设计样本。</span>
        </div>
        <Badge tone="outline">设计稿</Badge>
        <Icon name="chevron-right" />
      </button>
    </>
  )
}
