import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

export type ThemeMode = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

interface ThemeValue {
  mode: ThemeMode
  resolved: ResolvedTheme
  setMode: (mode: ThemeMode) => void
  toggle: () => void
}

const ThemeContext = createContext<ThemeValue | null>(null)
const STORAGE_KEY = 'mc-launcher.theme-mode'

function readMode(): ThemeMode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored
  } catch {
    /* file:// or privacy mode */
  }
  return 'system'
}

function systemDark(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(readMode)
  const [darkSystem, setDarkSystem] = useState(systemDark)

  const resolved: ResolvedTheme = mode === 'system' ? (darkSystem ? 'dark' : 'light') : mode

  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)')
    const onChange = (event: MediaQueryListEvent) => setDarkSystem(event.matches)
    media.addEventListener?.('change', onChange)
    return () => media.removeEventListener?.('change', onChange)
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = resolved
    document.documentElement.dataset.themeMode = mode
    document.documentElement.style.colorScheme = resolved
    try {
      localStorage.setItem(STORAGE_KEY, mode)
    } catch {
      /* best effort */
    }
  }, [mode, resolved])

  const setMode = useCallback((next: ThemeMode) => setModeState(next), [])
  const toggle = useCallback(() => {
    setModeState(resolved === 'dark' ? 'light' : 'dark')
  }, [resolved])

  const value = useMemo<ThemeValue>(
    () => ({ mode, resolved, setMode, toggle }),
    [mode, resolved, setMode, toggle],
  )
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeValue {
  const value = useContext(ThemeContext)
  if (!value) throw new Error('useTheme must be used inside ThemeProvider')
  return value
}
