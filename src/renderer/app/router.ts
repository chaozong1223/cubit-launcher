import { useEffect, useState } from 'react'

export interface Route {
  path: string
  name: 'home' | 'instances' | 'instance' | 'download' | 'catalog' | 'project' | 'updates' | 'saves' | 'schematics' | 'screenshots' | 'trash' | 'link' | 'sdk' | 'logs' | 'settings' | 'about' | 'spec' | 'perf'
  id?: string
  section?: string
}

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '')
  const parts = raw.split('/').filter(Boolean)
  const [first, second] = parts
  switch (first) {
    case 'instances': {
      // The instance list now lives on the home page; keep old links working.
      if (!second) return { path: '#/home', name: 'home' }
      const third = parts[2]
      return {
        path: third ? `#/instances/${second}/${third}` : `#/instances/${second}`,
        name: 'instance',
        id: decodeURIComponent(second),
        section: third,
      }
    }
    case 'download':
      return { path: '#/download', name: 'download' }
    case 'catalog':
      return second
        ? { path: `#/catalog/${second}`, name: 'catalog', section: second }
        : { path: '#/catalog', name: 'catalog' }
    case 'project':
      return second
        ? { path: `#/project/${second}`, name: 'project', section: second }
        : { path: '#/catalog', name: 'catalog' }
    case 'updates':
      return second
        ? { path: `#/updates/${second}`, name: 'updates', section: decodeURIComponent(second) }
        : { path: '#/updates', name: 'updates' }
    case 'saves':
      return second
        ? { path: `#/saves/${second}`, name: 'saves', section: decodeURIComponent(second) }
        : { path: '#/saves', name: 'saves' }
    case 'schematics':
      return second
        ? { path: `#/schematics/${second}`, name: 'schematics', section: decodeURIComponent(second) }
        : { path: '#/schematics', name: 'schematics' }
    case 'screenshots':
      return second
        ? { path: `#/screenshots/${second}`, name: 'screenshots', section: decodeURIComponent(second) }
        : { path: '#/screenshots', name: 'screenshots' }
    case 'trash':
      return { path: '#/trash', name: 'trash' }
    case 'link':
      return { path: '#/link', name: 'link' }
    case 'sdk':
      return { path: '#/sdk', name: 'sdk' }
    case 'logs':
      return { path: '#/logs', name: 'logs' }
    case 'perf':
      return { path: '#/perf', name: 'perf' }
    case 'settings':
      return { path: second ? `#/settings/${second}` : '#/settings', name: 'settings', section: second }
    case 'about':
      return { path: '#/about', name: 'about' }
    case 'components':
      return { path: '#/components', name: 'spec' }
    case 'home':
    case undefined:
      return { path: '#/home', name: 'home' }
    default:
      return { path: '#/home', name: 'home' }
  }
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(location.hash))
  useEffect(() => {
    const onChange = () => setRoute(parseHash(location.hash))
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return route
}

export function navigate(path: string): void {
  const next = path.startsWith('#') ? path : `#${path.startsWith('/') ? path : `/${path}`}`
  if (location.hash === next) {
    window.dispatchEvent(new HashChangeEvent('hashchange'))
    return
  }
  location.hash = next
}

export function routeTitle(route: Route): string {
  switch (route.name) {
    case 'home': return '主页'
    case 'instances': return '实例'
    case 'instance': return '实例详情'
    case 'download': return '安装与下载'
    case 'catalog': return '资源库'
    case 'project': return '项目详情'
    case 'updates': return '模组更新'
    case 'saves': return '存档'
    case 'schematics': return '投影管理'
    case 'screenshots': return '截图'
    case 'trash': return '回收站'
    case 'link': return '联机'
    case 'sdk': return '联机 SDK'
    case 'logs': return '日志'
    case 'perf': return '内存与性能'
    case 'settings': return '设置'
    case 'about': return '关于'
    case 'spec': return '界面规范'
  }
}
