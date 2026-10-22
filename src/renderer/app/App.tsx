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
    { path: '#/instances', name: 'instances', label: '实例', icon: 'instances' },
    { path: '#/saves', name: 'saves', label: '存档', icon: 'cube' },
    { path: '#/schematics', name: 'schematics', label: '投影管理', icon: 'schematic' },
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

function Rail({ route, collapsed, onToggle }: { route: Route; collapsed: boolean; onToggle: () => void }) {
  const accounts = useCurrentAccount()
  const current = accounts.data?.accounts.find((account) => account.id === accounts.data?.selectedId) ?? accounts.data?.accounts[0] ?? null
  const navActive = route.name === 'instance' ? 'instances' : route.name === 'spec' ? 'about' : route.name
  return (
    <nav className="rail rail--icons" aria-label="主导航">
      <button
        className="rail-btn rail-btn--menu"
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        aria-controls="subnav"
        aria-label={collapsed ? '展开导航菜单' : '收起导航菜单'}
        title={collapsed ? '展开导航菜单' : '收起导航菜单'}
      >
        <Icon name="menu" />
      </button>
      <div className="rail__scroll">
        {NAV_GROUPS.map((group, groupIndex) => (
          <div className="rail__group" key={group.label}>
            {groupIndex > 0 ? <div className="rail__sep" aria-hidden="true" /> : null}
            {group.items.map((item) => (
              <a
                className="rail-btn"
                href={item.path}
                key={item.path}
                title={item.label}
                aria-label={item.label}
                aria-current={navActive === item.name ? 'page' : undefined}
              >
                <Icon name={item.icon} />
              </a>
            ))}
          </div>
        ))}
      </div>
      <div className="rail__footer">
        <button
          className="rail-avatar"
          type="button"
          onClick={() => navigate('/settings/account')}
          title={current ? `${current.name} · ${current.kind} 账户` : '账户未接入'}
          aria-label="账户"
        >
          <span className="avatar avatar--sm" aria-hidden="true">{(current?.name ?? 'L').slice(0, 1).toUpperCase()}</span>
        </button>
        <button
          className="rail-btn rail-btn--ghost"
          type="button"
          aria-label="界面规范"
          title="界面规范"
          onClick={() => navigate('/components')}
        >
          <Icon name="flask" />
        </button>
      </div>
    </nav>
  )
}

/**
 * Secondary column, modelled after StarCloud Launcher: a context card on top and
 * the full navigation menu underneath (all sections, grouped), so the icon rail
 * can stay icon-only while labels live here.
 */
function SubNav({ route }: { route: Route }) {
  const system = useSystem()
  const accounts = useCurrentAccount()
  const navActive = route.name === 'instance' ? 'instances' : route.name === 'spec' ? 'about' : route.name
  const current =
    accounts.data?.accounts.find((account) => account.id === accounts.data?.selectedId) ??
    accounts.data?.accounts[0] ??
    null

  return (
    <aside className="subnav" id="subnav" aria-label="主导航">
      <div className="subnav__card">
        <div className="subnav__card-kicker">本地运行</div>
        <div className="subnav__card-value">{current ? current.name : '本地用户'}</div>
        <div className="subnav__card-meta">
          {current ? `${current.kind} 账户` : '账户未接入'} · v{system.version ?? '0.1.0'}
        </div>
      </div>
      {NAV_GROUPS.map((group) => (
        <div className="subnav__group" key={group.label}>
          <div className="subnav__title">{group.label}</div>
          <div className="subnav__list">
            {group.items.map((item) => (
              <a
                className="subnav__item"
                href={item.path}
                key={item.path}
                aria-current={navActive === item.name ? 'page' : undefined}
              >
                <Icon name={item.icon} className="ico ico--sm" />
                <span>{item.label}</span>
              </a>
            ))}
          </div>
        </div>
      ))}
      <div className="subnav__footer">
        <button className="subnav__item subnav__item--button" type="button" onClick={() => navigate('/components')}>
          <Icon name="flask" className="ico ico--sm" />
          <span>界面规范</span>
        </button>
      </div>
    </aside>
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
  const [navCollapsed, setNavCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem('cubit.nav.collapsed') === '1'
    } catch {
      return false
    }
  })
  const toggleNav = useCallback(() => {
    setNavCollapsed((previous) => {
      const next = !previous
      try {
        window.localStorage.setItem('cubit.nav.collapsed', next ? '1' : '0')
      } catch {
        /* storage unavailable: the toggle still works for this session */
      }
      return next
    })
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
          <Rail route={route} collapsed={navCollapsed} onToggle={toggleNav} />
          <SubNav route={route} />
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
