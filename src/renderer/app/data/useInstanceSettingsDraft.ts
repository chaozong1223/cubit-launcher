import { useEffect, useState } from 'react'
import type { InstancePatch, InstanceSummary } from '@shared/instance'
import type { LaunchPlan } from '@shared/launch'
import type { JavaCandidate } from '@shared/java'
import { useBackend } from './BackendContext'
import { describeError, type UiErrorInfo } from './backend'
import { useAsync } from './useAsync'

type JavaMode = 'auto' | 'path'

export interface InstanceSettingsDraft {
  instance: InstanceSummary
  plan: LaunchPlan | null
  planError: UiErrorInfo | null
  planLoading: boolean
  javaCandidates: JavaCandidate[]
  javaError: UiErrorInfo | null
  javaLoading: boolean
  minMb: string
  setMinMb: (value: string) => void
  maxMb: string
  setMaxMb: (value: string) => void
  width: string
  setWidth: (value: string) => void
  height: string
  setHeight: (value: string) => void
  fullscreen: boolean
  setFullscreen: (value: boolean) => void
  jvmText: string
  setJvmText: (value: string) => void
  javaMode: JavaMode
  setJavaMode: (value: JavaMode) => void
  javaPath: string
  setJavaPath: (value: string) => void
  saving: boolean
  saveError: UiErrorInfo | null
  savedAt: number | null
  save: () => Promise<void>
  reloadPlan: () => void
  reloadJava: () => void
}

function argValue(argv: string[], flag: string): string | null {
  const index = argv.indexOf(flag)
  if (index >= 0 && index + 1 < argv.length) return argv[index + 1]
  const prefixed = argv.find((arg) => arg.startsWith(`${flag}=`))
  return prefixed ? prefixed.slice(flag.length + 1) : null
}

function memoryMb(argv: string[], flag: '-Xms' | '-Xmx', fallback: number): number {
  const arg = argv.find((value) => value.startsWith(flag))
  if (!arg) return fallback
  const raw = arg.slice(flag.length).trim()
  const match = /^(\d+)([mMgG]?)$/.exec(raw)
  if (!match) return fallback
  const amount = Number(match[1])
  return match[2].toLowerCase() === 'g' ? amount * 1024 : amount
}

function parseJvmArgs(text: string): string[] {
  const tokens = text.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []
  return tokens.map((token) => token.replace(/^(["'])(.*)\1$/, '$2')).filter(Boolean)
}

/**
 * Bridges the per-instance settings (instance.json) to the UI.
 *
 * The instance contract intentionally exposes a summary, not the settings
 * object. We hydrate the effective memory/window/Java from the real launch
 * dry-run and keep the user's custom JVM argument text in a local mirror after
 * a successful instance.update. Every save writes through instance.update.
 */
export function useInstanceSettingsDraft(instance: InstanceSummary | null): InstanceSettingsDraft | null {
  const backend = useBackend()
  const accounts = useAsync(() => backend.auth.list(), [])
  const accountId = accounts.data?.selectedId ?? accounts.data?.accounts[0]?.id ?? null
  const plan = useAsync<LaunchPlan | null>(
    () => instance ? backend.launch.plan(instance.id, accountId) : Promise.resolve(null),
    [instance?.id, accountId],
  )
  const java = useAsync(() => backend.java.detect(false), [])

  const [minMb, setMinMb] = useState('1024')
  const [maxMb, setMaxMb] = useState('4096')
  const [width, setWidth] = useState('1280')
  const [height, setHeight] = useState('720')
  const [fullscreen, setFullscreen] = useState(false)
  const [jvmText, setJvmText] = useState('')
  const [javaMode, setJavaMode] = useState<JavaMode>('auto')
  const [javaPath, setJavaPath] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<UiErrorInfo | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  const jvmKey = instance ? `mcl.settings.jvmArgs.${instance.id}` : ''
  const mirrorKey = instance ? `mcl.settings.instance.${instance.id}` : ''

  useEffect(() => {
    if (!instance || !mirrorKey) {
      setJvmText('')
      return
    }
    const fallbackJvm = jvmKey ? localStorage.getItem(jvmKey) ?? '' : ''
    try {
      const raw = localStorage.getItem(mirrorKey)
      if (raw) {
        const mirror = JSON.parse(raw) as Partial<{
          minMb: string
          maxMb: string
          width: string
          height: string
          fullscreen: boolean
          javaMode: JavaMode
          javaPath: string
          jvmText: string
        }>
        if (mirror.minMb) setMinMb(mirror.minMb)
        if (mirror.maxMb) setMaxMb(mirror.maxMb)
        if (mirror.width) setWidth(mirror.width)
        if (mirror.height) setHeight(mirror.height)
        if (typeof mirror.fullscreen === 'boolean') setFullscreen(mirror.fullscreen)
        if (mirror.javaMode === 'auto' || mirror.javaMode === 'path') setJavaMode(mirror.javaMode)
        if (typeof mirror.javaPath === 'string') setJavaPath(mirror.javaPath)
        setJvmText(typeof mirror.jvmText === 'string' ? mirror.jvmText : fallbackJvm)
      } else {
        setJvmText(fallbackJvm)
      }
    } catch {
      setJvmText(fallbackJvm)
    }
    setSaveError(null)
    setSavedAt(null)
  }, [instance?.id, jvmKey, mirrorKey])

  useEffect(() => {
    if (!instance || !plan.data) return
    const argv = plan.data.argv
    setMinMb(String(memoryMb(argv, '-Xms', 1024)))
    setMaxMb(String(memoryMb(argv, '-Xmx', 4096)))
    setWidth(argValue(argv, '--width') ?? '1280')
    setHeight(argValue(argv, '--height') ?? '720')
    setFullscreen(argv.includes('--fullscreen'))
    setJavaPath(plan.data.javaPath || '')
    setJavaMode(plan.data.javaPath ? 'path' : 'auto')
  }, [instance?.id, plan.data])

  if (!instance) return null

  const save = async (): Promise<void> => {
    setSaving(true)
    setSaveError(null)
    setSavedAt(null)
    try {
      const min = Number(minMb)
      const max = Number(maxMb)
      const nextWidth = Number(width)
      const nextHeight = Number(height)
      if (!Number.isInteger(min) || !Number.isInteger(max) || min < 512 || max > 65536 || min > max) {
        throw new Error('内存需为 512–65536 MB 的整数，且最小值不能大于最大值')
      }
      if (!Number.isInteger(nextWidth) || nextWidth < 320 || nextWidth > 7680) throw new Error('窗口宽度需在 320–7680 之间')
      if (!Number.isInteger(nextHeight) || nextHeight < 240 || nextHeight > 4320) throw new Error('窗口高度需在 240–4320 之间')
      const patch: InstancePatch = {
        memory: { minMb: min, maxMb: max },
        window: { width: nextWidth, height: nextHeight, fullscreen },
        jvmArgs: parseJvmArgs(jvmText),
        java: javaMode === 'auto' || !javaPath
          ? { mode: 'auto', value: null }
          : { mode: 'path', value: javaPath },
      }
      await backend.instances.update(instance.id, patch)
      localStorage.setItem(jvmKey, jvmText)
      localStorage.setItem(mirrorKey, JSON.stringify({
        minMb,
        maxMb,
        width,
        height,
        fullscreen,
        javaMode,
        javaPath,
        jvmText,
      }))
      setSavedAt(Date.now())
      plan.reload()
    } catch (cause) {
      setSaveError(describeError(cause))
    } finally {
      setSaving(false)
    }
  }

  return {
    instance,
    plan: plan.data,
    planError: plan.status === 'error' || plan.status === 'not-wired' ? describeError(plan.error) : null,
    planLoading: plan.status === 'loading',
    javaCandidates: java.data?.candidates ?? [],
    javaError: java.status === 'error' || java.status === 'not-wired' ? describeError(java.error) : null,
    javaLoading: java.status === 'loading',
    minMb,
    setMinMb,
    maxMb,
    setMaxMb,
    width,
    setWidth,
    height,
    setHeight,
    fullscreen,
    setFullscreen,
    jvmText,
    setJvmText,
    javaMode,
    setJavaMode,
    javaPath,
    setJavaPath,
    saving,
    saveError,
    savedAt,
    save,
    reloadPlan: plan.reload,
    reloadJava: java.reload,
  }
}
