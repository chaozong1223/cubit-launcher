import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppInfo } from '@shared/system'
import type { RendererReadyReport } from '@shared/channels'
import { useBackend } from './data/BackendContext'
import { useCurrentAccount } from './data/useAccount'
import { describeError } from './data/backend'
import { useTheme } from './theme'
import { navigate, routeTitle, useRoute, type Route } from './router'
import { SystemProvider, useSystem, type SecurityFlags, type SystemValue } from './system'
import { Icon, CubeMark } from './icons'
import { Badge, Button } from './ui'
import { HomePage } from './pages/HomePage'
import { InstancesPage } from './pages/InstancesPage'
import { InstanceDetailPage } from './pages/InstanceDetailPage'
import { DownloadPage } from './pages/DownloadPage'
import { CatalogPage } from './pages/CatalogPage'
import { SavesPage } from './pages/SavesPage'
import { SchematicsPage } from './pages/SchematicsPage'
import { ScreenshotsPage } from './pages/ScreenshotsPage'
import { TrashPage } from './pages/TrashPage'
import { LinkPage } from './pages/LinkPage'
import { SdkPage } from './pages/SdkPage'
import { LogsPage } from './pages/LogsPage'
import { PerfPage } from './pages/PerfPage'
import { SettingsPage } from './pages/SettingsPage'
import { AboutPage } from './pages/AboutPage'
import { SpecPage } from './pages/SpecPage'
import { GlobalDropZone } from './GlobalDropZone'

const NAV_GROUPS: ReadonlyArray<{ label: string; items: ReadonlyArray<{ path: string; name: Route['name']; label: string; icon: Parameters<typeof Icon>[0]['name'] }> }> = [
  { label: '游玩', items: [
    { path: '#/home', name: 'home', label: '主页', icon: 'home' },
    { path: '#/screenshots', name: 'screenshots', label: '截图', icon: 'package' },
  ] },
  { label: '获取', items: [
    { path: '#/download', name: 'download', label: '安装与下载', icon: 'download' },
    { path: '#/catalog', name: 'catalog', label: '资源库', icon: 'package' },
    { path: '#/updates', name: 'updates', label: '模组更新', icon: 'refresh' },
  ] },
  { label: '一起玩', items: [
    { path: '#/link', name: 'link', label: '联机', icon: 'link' },
    { path: '#/sdk', name: 'sdk', label: '联机 SDK', icon: 'network' },
  ] },
  { label: '系统', items: [
    { path: '#/logs', name: 'logs', label: '日志', icon: 'terminal' },
    { path: '#/perf', name: 'perf', label: '内存与性能', icon: 'activity' },
    { path: '#/trash', name: 'trash', label: '回收站', icon: 'trash' },
    { path: '#/settings', name: 'settings', label: '设置', icon: 'settings' },
    { path: '#/about', name: 'about', label: '关于', icon: 'info' },
  ] },
]

function readGlobal(name: 'require' | 'process'): unknown {
  return (window as unknown as Record<string, unknown>)[name]
}

function TitleBar({ route }: { route: Route }) {
  const backend = useBackend()
  const theme = useTheme()
  const system = useSystem()
  const accounts = useCurrentAccount()
  const current = accounts.data?.accounts.find((account) => account.id === accounts.data?.selectedId) ?? accounts.data?.accounts[0] ?? null

  const winAction = (action: 'minimize' | 'maximize' | 'close') => {
    void backend.system[action]().catch(() => {
      /* window may be closing; no user-facing action needed */
    })
  }

  return (
    <header className="titlebar">
      <div className="titlebar__brand">
        <CubeMark />
        <span className="brand-word">Cubit</span>
        <span className="brand-tag">LAUNCHER</span>
      </div>
      <div className="titlebar__divider" aria-hidden="true" />
      <div className="titlebar__crumb">{route.name === 'instance' ? '实例 / 详情' : routeTitle(route)}</div>
      <div className="titlebar__spacer" />
      <div className="titlebar__status" title="本地桌面会话；数据来自 IPC">
        <span className="status-dot status-dot--ok" />
        <span>本地运行</span>
      </div>
      <button className="btn btn--icon btn--ghost" type="button" aria-label={`切换到${theme.resolved === 'dark' ? '浅色' : '深色'}主题`} title="切换主题" onClick={theme.toggle}>
        <Icon name={theme.resolved === 'dark' ? 'sun' : 'moon'} />
      </button>
      <button className="titlebar__account" type="button" onClick={() => navigate('/settings/account')} title={current ? `${current.name} · ${current.kind}` : '账户尚未接入'}>
        <span className="avatar avatar--sm" aria-hidden="true">{(current?.name ?? 'L').slice(0, 1).toUpperCase()}</span>
        <span className="titlebar__account-name">{current?.name ?? '本地用户'}</span>
        <Icon name="chevron-down" className="ico ico--xs subtle" />
      </button>
      <div className="win-controls" aria-hidden="true">
        <button className="win-btn" type="button" aria-label="最小化" onClick={() => winAction('minimize')}><Icon name="window-min" className="win-ico" /></button>
        <button className="win-btn" type="button" aria-label="最大化" onClick={() => winAction('maximize')}><Icon name="window-max" className="win-ico" /></button>
        <button className="win-btn win-btn--close" type="button" aria-label="关闭" onClick={() => winAction('close')}><Icon name="window-close" className="win-ico" /></button>
      </div>
      <span className="sr-only">{system.version ? `版本 ${system.version}` : '正在读取系统信息'}</span>
    </header>
  )
}

/**
 * Single-column sidebar, like StarCloud: one list with icon + label. Collapsing
 * narrows the very same list down to icons (no separate icon rail beside it).
 */
function Nav({ route, collapsed, onToggle }: { route: Route; collapsed: boolean; onToggle: () => void }) {
  const navActive = route.name === 'instance' ? 'instances' : route.name === 'spec' ? 'about' : route.name
  const primary = NAV_GROUPS.filter((group) => group.label !== '系统').flatMap((group) => group.items)
  const secondary = NAV_GROUPS.filter((group) => group.label === '系统').flatMap((group) => group.items)

  const renderItem = (entry: { path: string; name: Route['name']; label: string; icon: Parameters<typeof Icon>[0]['name'] }) => (
    <a
      className="nav__item"
      href={entry.path}
      key={entry.path}
      title={entry.label}
      aria-current={navActive === entry.name ? 'page' : undefined}
    >
      <Icon name={entry.icon} className="ico ico--sm" />
      <span className="nav__label">{entry.label}</span>
    </a>
  )

  return (
    <nav className={collapsed ? 'nav nav--collapsed' : 'nav'} aria-label="主导航">
      <button
        className="nav__toggle"
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        aria-label={collapsed ? '展开导航菜单' : '收起导航菜单'}
        title={collapsed ? '展开导航菜单' : '收起导航菜单'}
      >
        <Icon name="menu" />
      </button>
      <div className="nav__list">{primary.map(renderItem)}</div>
      <div className="nav__divider" aria-hidden="true" />
      <div className="nav__list">{secondary.map(renderItem)}</div>
      <div className="nav__footer">
        <a className="nav__item" href="#/components" title="界面规范">
          <Icon name="flask" className="ico ico--sm" />
          <span className="nav__label">界面规范</span>
        </a>
      </div>
    </nav>
  )
}

function Page({ route }: { route: Route }) {
  switch (route.name) {
    case 'home': return <HomePage />
    case 'instances': return <InstancesPage />
    case 'instance': return <InstanceDetailPage />
    case 'download': return <DownloadPage />
    case 'catalog': return <CatalogPage mode="search" />
    case 'updates': return <CatalogPage mode="updates" />
    case 'saves': return <SavesPage />
    case 'schematics': return <SchematicsPage />
    case 'screenshots': return <ScreenshotsPage />
    case 'trash': return <TrashPage />
    case 'link': return <LinkPage />
    case 'sdk': return <SdkPage />
    case 'logs': return <LogsPage />
    case 'perf': return <PerfPage />
    case 'settings': return <SettingsPage />
    case 'about': return <AboutPage />
    case 'spec': return <SpecPage />
  }
}

export default function App() {
  const backend = useBackend()
  const route = useRoute()
  // Always starts expanded: a remembered collapsed state made the app look
  // "broken" on launch (only the icon rail) because the toggle lives in the rail.
  const [navCollapsed, setNavCollapsed] = useState(false)
  const toggleNav = useCallback(() => {
    setNavCollapsed((previous) => !previous)
  }, [])
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [version, setVersion] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<unknown>(null)
  const [flags, setFlags] = useState<SecurityFlags>({
    nodeRequire: typeof readGlobal('require') !== 'undefined',
    nodeProcess: typeof readGlobal('process') !== 'undefined',
    blockedChannelRejected: null,
  })
  const errorsRef = useRef<string[]>([])
  const reported = useRef(false)

  const load = useCallback(async (): Promise<{ info: AppInfo; version: string } | null> => {
    setLoading(true)
    setError(null)
    try {
      const [nextInfo, nextVersion] = await Promise.all([backend.system.info(), backend.system.version()])
      setInfo(nextInfo)
      setVersion(nextVersion)
      return { info: nextInfo, version: nextVersion }
    } catch (cause) {
      setError(cause)
      errorsRef.current.push(`system info failed: ${describeError(cause).detail}`)
      return null
    } finally {
      setLoading(false)
    }
  }, [backend])

  useEffect(() => {
    const onError = (event: ErrorEvent) => errorsRef.current.push(event.message)
    const onRejection = (event: PromiseRejectionEvent) => errorsRef.current.push(`unhandled rejection: ${String(event.reason)}`)
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)

    void (async () => {
      const loaded = await load()
      let blocked = false
      try {
        blocked = await backend.system.probeBlockedChannel()
      } catch (cause) {
        errorsRef.current.push(`blocked-channel probe failed: ${describeError(cause).detail}`)
      }
      const nextFlags: SecurityFlags = {
        nodeRequire: typeof readGlobal('require') !== 'undefined',
        nodeProcess: typeof readGlobal('process') !== 'undefined',
        blockedChannelRejected: blocked,
      }
      setFlags(nextFlags)

      if (!reported.current) {
        reported.current = true
        await new Promise((resolve) => window.setTimeout(resolve, 120))
        const report: RendererReadyReport = {
          version: loaded?.version ?? '',
          errors: [...errorsRef.current],
          nodeRequire: nextFlags.nodeRequire,
          nodeProcess: nextFlags.nodeProcess,
          blockedChannelRejected: blocked,
          href: location.href,
        }
        try {
          await backend.system.reportReady(report)
        } catch (cause) {
          errorsRef.current.push(`renderer handshake failed: ${describeError(cause).detail}`)
        }
      }
    })()

    return () => {
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onRejection)
    }
  }, [backend, load])

  useEffect(() => {
    document.title = `${routeTitle(route)} · Cubit Launcher`
  }, [route])

  const systemValue = useMemo<SystemValue>(
    () => ({ info, version, loading, error, reload: () => void load(), flags }),
    [info, version, loading, error, load, flags],
  )

  return (
    <SystemProvider value={systemValue}>
      <GlobalDropZone />
      <div className="app">
        <TitleBar route={route} />
        <div className={navCollapsed ? 'shell shell--nav-collapsed' : 'shell'}>
          <Nav route={route} collapsed={navCollapsed} onToggle={toggleNav} />
          <main className="content" id="content">
            <div className="page" key={route.path}>
              <Page route={route} />
            </div>
          </main>
        </div>
      </div>
    </SystemProvider>
  )
}
