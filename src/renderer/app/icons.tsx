import type { ReactNode } from 'react'

export type IconName =
  | 'home'
  | 'instances'
  | 'download'
  | 'link'
  | 'terminal'
  | 'settings'
  | 'info'
  | 'play'
  | 'pause'
  | 'folder'
  | 'more'
  | 'search'
  | 'chevron-down'
  | 'chevron-right'
  | 'chevron-left'
  | 'arrow-left'
  | 'plus'
  | 'check'
  | 'close'
  | 'alert'
  | 'alert-circle'
  | 'refresh'
  | 'copy'
  | 'external'
  | 'upload'
  | 'sun'
  | 'moon'
  | 'user'
  | 'coffee'
  | 'memory'
  | 'lock'
  | 'shield'
  | 'flask'
  | 'cube'
  | 'wifi'
  | 'network'
  | 'activity'
  | 'clock'
  | 'edit'
  | 'trash'
  | 'package'
  | 'window-min'
  | 'window-max'
  | 'window-close'

const ICONS: Record<IconName, ReactNode> = {
  home: <><path d="M3 10.7 12 3.2l9 7.5" /><path d="M5.5 9.2V20h13V9.2" /><path d="M9.8 20v-5.4h4.4V20" /></>,
  instances: <><rect x="3.2" y="3.2" width="7.4" height="7.4" rx="1.4" /><rect x="13.4" y="3.2" width="7.4" height="7.4" rx="1.4" /><rect x="3.2" y="13.4" width="7.4" height="7.4" rx="1.4" /><rect x="13.4" y="13.4" width="7.4" height="7.4" rx="1.4" /></>,
  download: <><path d="M12 3.5v11" /><path d="m7.5 10.2 4.5 4.5 4.5-4.5" /><path d="M4 16.5v2.2a1.8 1.8 0 0 0 1.8 1.8h12.4a1.8 1.8 0 0 0 1.8-1.8v-2.2" /></>,
  link: <><circle cx="6" cy="12" r="2.2" /><circle cx="18" cy="6" r="2.2" /><circle cx="18" cy="18" r="2.2" /><path d="m8 11 7.8-4M8 13l7.8 4" /></>,
  terminal: <><rect x="3" y="4.2" width="18" height="15.6" rx="2" /><path d="m7.5 9 3 3-3 3M13.5 15h3.2" /></>,
  settings: <><path d="M4 7h9M17 7h3M4 17h3M11 17h9M4 12h3M11 12h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" /><circle cx="7" cy="12" r="2" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5.5M12 7.6v.2" /></>,
  play: <path d="M8 5.4v13.2L19 12 8 5.4Z" fill="currentColor" stroke="none" />,
  pause: <path d="M8.5 5.5v13M15.5 5.5v13" strokeWidth="2.6" />,
  folder: <path d="M3.2 6.8a1.8 1.8 0 0 1 1.8-1.8h4l2 2.2h7a1.8 1.8 0 0 1 1.8 1.8v9.2a1.8 1.8 0 0 1-1.8 1.8H5a1.8 1.8 0 0 1-1.8-1.8V6.8Z" />,
  more: <><circle cx="5.5" cy="12" r="1.2" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" /><circle cx="18.5" cy="12" r="1.2" fill="currentColor" stroke="none" /></>,
  search: <><circle cx="10.8" cy="10.8" r="6.4" /><path d="m15.6 15.6 4.2 4.2" /></>,
  'chevron-down': <path d="m6.5 9.5 5.5 5.5 5.5-5.5" />,
  'chevron-right': <path d="m9.5 6.5 5.5 5.5-5.5 5.5" />,
  'chevron-left': <path d="m14.5 6.5-5.5 5.5 5.5 5.5" />,
  'arrow-left': <path d="M20 12H4.5M10 6.5 4.5 12l5.5 5.5" />,
  plus: <path d="M12 4.5v15M4.5 12h15" />,
  check: <path d="m4.5 12.5 5 5 10-11" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  alert: <><path d="M12 3.8 21 20H3L12 3.8Z" /><path d="M12 9.4v4.8M12 17.2v.2" /></>,
  'alert-circle': <><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5.2M12 16.5v.2" /></>,
  refresh: <><path d="M20 11a8 8 0 1 0-2.3 6.7" /><path d="M20 4.5V11h-6.5" /></>,
  copy: <><rect x="8.5" y="8.5" width="11.5" height="11.5" rx="1.8" /><path d="M15.5 8.5V5.8A1.8 1.8 0 0 0 13.7 4H5.8A1.8 1.8 0 0 0 4 5.8v7.9a1.8 1.8 0 0 0 1.8 1.8h2.7" /></>,
  external: <><path d="M13.5 4.5H19.5V10.5" /><path d="m19 5-8 8" /><path d="M18.5 14.5v3a2 2 0 0 1-2 2h-10a2 2 0 0 1-2-2v-10a2 2 0 0 1 2-2h3" /></>,
  upload: <><path d="M12 16.5v-13" /><path d="m7.5 8 4.5-4.5L16.5 8" /><path d="M4 16.5v2.2a1.8 1.8 0 0 0 1.8 1.8h12.4a1.8 1.8 0 0 0 1.8-1.8v-2.2" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6" /></>,
  moon: <path d="M20 14.4A8.2 8.2 0 0 1 9.6 4a8.4 8.4 0 1 0 10.4 10.4Z" />,
  user: <><circle cx="12" cy="8.2" r="3.8" /><path d="M4.5 20a7.5 7.5 0 0 1 15 0" /></>,
  coffee: <><path d="M4.5 8.5h12v5.2a5 5 0 0 1-5 5h-2a5 5 0 0 1-5-5V8.5Z" /><path d="M16.5 9.5h1.8a2.6 2.6 0 0 1 0 5.2h-1.8M7 4.5c-.8 1 .8 1.4 0 2.4M11 4.5c-.8 1 .8 1.4 0 2.4" /></>,
  memory: <><rect x="3.2" y="7" width="17.6" height="10" rx="1.8" /><path d="M7 10v4M10 10v4M13 10v4M16 10v4" /></>,
  lock: <><rect x="5" y="10" width="14" height="10" rx="2" /><path d="M8 10V7.5a4 4 0 0 1 8 0V10" /></>,
  shield: <><path d="M12 3 20 6v5.7c0 4.4-3.2 7.6-8 9.3-4.8-1.7-8-4.9-8-9.3V6l8-3Z" /><path d="m8.5 11.8 2.3 2.3 4.7-4.9" /></>,
  flask: <><path d="M9 3.5h6M10 3.5v6L4.8 18a2 2 0 0 0 1.7 3h11a2 2 0 0 0 1.7-3L14 9.5v-6" /><path d="M7 14h10" /></>,
  cube: <><path d="M12 2.6 21 7.5v9L12 21.4 3 16.5v-9L12 2.6Z" /><path d="M3 7.5 12 12.4l9-4.9M12 12.4v9" opacity=".68" /></>,
  wifi: <><path d="M3.5 9.2a12.6 12.6 0 0 1 17 0M6.5 12.7a8 8 0 0 1 11 0M9.5 16.2a3.5 3.5 0 0 1 5 0" /><circle cx="12" cy="19.2" r="1.1" fill="currentColor" stroke="none" /></>,
  network: <><circle cx="12" cy="12" r="8.8" /><path d="M3.4 12h17.2M12 3.2c2.4 2.6 3.6 5.6 3.6 8.8S14.4 18.2 12 20.8c-2.4-2.6-3.6-5.6-3.6-8.8S9.6 5.8 12 3.2Z" /></>,
  activity: <path d="M3 12h4l2.3-6 4 12 2.2-6H21" />,
  clock: <><circle cx="12" cy="12" r="8.8" /><path d="M12 7.2V12l3.2 2" /></>,
  edit: <path d="m14.5 5.2 4.3 4.3M4.5 19.5l1-4.6L16 4.4a1.6 1.6 0 0 1 2.3 0l1.3 1.3a1.6 1.6 0 0 1 0 2.3L9.1 18.5l-4.6 1Z" />,
  trash: <path d="M4.5 7h15M9.5 7V4.8h5V7M6.8 7l.8 12.2a1.8 1.8 0 0 0 1.8 1.6h5.2a1.8 1.8 0 0 0 1.8-1.6L17.2 7M10 10.8v6M14 10.8v6" />,
  package: <><path d="m12 3 8 4.2v9.6L12 21l-8-4.2V7.2L12 3Z" /><path d="m4 7.2 8 4.2 8-4.2M12 11.4V21" /></>,
  'window-min': <path d="M4 12h16" />,
  'window-max': <rect x="4.4" y="4.4" width="15.2" height="15.2" rx="1.2" />,
  'window-close': <path d="m5 5 14 14M19 5 5 19" />,
}

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg className={className ? `ico ${className}` : 'ico'} viewBox="0 0 24 24" aria-hidden="true">
      {ICONS[name]}
    </svg>
  )
}

export function CubeMark({ className = 'brand-mark' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2.6 21 7.5v9L12 21.4 3 16.5v-9L12 2.6Z" />
      <path d="M3 7.5 12 12.4l9-4.9M12 12.4v9" opacity=".68" />
    </svg>
  )
}
