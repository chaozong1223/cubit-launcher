import { useEffect, useState } from 'react'

export interface Route {
  path: string
  name: 'home' | 'instances' | 'instance' | 'download' | 'catalog' | 'updates' | 'saves' | 'schematics' | 'screenshots' | 'trash' | 'link' | 'sdk' | 'logs' | 'settings' | 'about' | 'spec' | 'perf'
  id?: string
  section?: string
}

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '')
  const parts = raw.split('/').filter(Boolean)
  const [first, second] = parts
  switch (first) {
    case 'instances': {
      if (!second) return { path: '#/instances', name: 'instances' }
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
    case 'updates':
      return { path: '#/updates', name: 'updates' }
    case 'saves':
      return { path: '#/saves', name: 'saves' }
    case 'schematics':
      return { path: '#/schematics', name: 'schematics' }
    case 'screenshots':
      return { path: '#/screenshots', name: 'screenshots' }
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
