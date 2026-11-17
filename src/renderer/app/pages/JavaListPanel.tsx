import { useState } from 'react'
import type { JavaCandidate } from '@shared/java'
import { useBackend } from '../data/BackendContext'
import { describeError, type UiErrorInfo } from '../data/backend'
import { useAsync } from '../data/useAsync'
import { Badge, Banner, Button, DataStateNotice, EmptyState } from '../ui'
import { Icon } from '../icons'

const SOURCE_LABEL: Record<string, string> = {
  'mojang-runtime': 'Mojang 运行时',
  'launcher-runtime': '启动器托管',
  'java-home': 'JAVA_HOME',
  'registry': '系统注册表',
  'path': 'PATH',
  'manual': '手动添加',
}

function sourceLabel(source: string): string {
  return SOURCE_LABEL[source] ?? source
}

function bitLabel(bits: JavaCandidate['bits']): string {
  return bits === 32 || bits === 64 ? `${bits} 位` : '位数未知'
}

/**
 * Every Java the launcher can see, with the global default at a glance.
 *
 * This is the surface VersePC2 has and we did not: the backend already exposed
 * candidates/settings/updateSettings, nothing rendered them.
 */
export function JavaListPanel() {
  const backend = useBackend()
  const candidates = useAsync(() => backend.java.candidates(), [])
  const settings = useAsync(() => backend.java.settings(), [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<UiErrorInfo | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const refresh = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await backend.java.detect(true)
      candidates.reload()
      settings.reload()
      setNotice('已重新扫描 Java')
      window.setTimeout(() => setNotice(null), 2500)
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setBusy(false)
    }
  }

  const makeDefault = async (candidate: JavaCandidate): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await backend.java.updateSettings({
        defaultJava: { mode: 'path', value: candidate.path },
      })
      settings.reload()
      setNotice(`默认 Java 已切换到 ${candidate.version.raw}`)
      window.setTimeout(() => setNotice(null), 2500)
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setBusy(false)
    }
  }

  const resetDefault = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await backend.java.updateSettings({ defaultJava: { mode: 'auto', value: null } })
      settings.reload()
      setNotice('默认 Java 已恢复自动选择')
      window.setTimeout(() => setNotice(null), 2500)
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setBusy(false)
    }
  }

  const defaultOverride = settings.data?.defaultJava ?? null
  const defaultPath = defaultOverride?.mode === 'path' && typeof defaultOverride.value === 'string'
    ? defaultOverride.value
    : null
  const rows = candidates.data ?? []

  if (candidates.status === 'loading') {
    return <div className="nw-stack"><span className="spinner" />正在扫描 Java…</div>
  }
  if (candidates.status === 'error' || candidates.status === 'not-wired') {
    return (
      <DataStateNotice
        info={describeError(candidates.error)}
        onRetry={() => candidates.reload()}
      />
    )
  }

  return (
    <div className="nw-stack">
      <div className="settings-section__head">
        <div>
          <h2>已安装的 Java</h2>
          <p>
            {rows.length > 0
              ? `共 ${rows.length} 个候选；默认${
                  defaultOverride?.mode === 'auto'
                    ? '自动（按版本要求挑选）'
                    : defaultOverride?.mode === 'major'
                      ? `主版本 ${String(defaultOverride.value)}`
                      : '手动指定的路径'
                }`
              : '没有检测到可用的 Java'}
          </p>
        </div>
        <div className="row gap-8">
          <Button size="sm" variant="secondary" icon="refresh" onClick={() => void refresh()} loading={busy}>刷新列表</Button>
          {defaultOverride && defaultOverride.mode !== 'auto' ? (
            <Button size="sm" variant="ghost" onClick={() => void resetDefault()} disabled={busy}>恢复自动</Button>
          ) : null}
        </div>
      </div>

      {notice ? <Banner tone="success" title={notice} /> : null}
      {error ? <Banner tone="danger" title={`${error.title}：${error.detail}`} /> : null}

      {rows.length === 0 ? (
        <EmptyState
          icon="coffee"
          title="没有找到 Java"
          description="安装一个 Java 运行时，或到「安装与下载」里让启动器自动下载；也可以把已有的 java.exe 放进启动器目录后刷新。"
        />
      ) : (
        <div className="nw-stack">
          {rows.map((candidate) => {
            const isDefault = defaultPath !== null && candidate.path.toLowerCase() === defaultPath.toLowerCase()
            return (
              <div
                key={candidate.path}
                className="instance-settings-card"
                style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}
              >
                <div style={{ minWidth: 0, flex: '1 1 320px' }}>
                  <div className="row gap-8" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
                    <strong>Java {candidate.version.major}</strong>
                    <span className="muted">({candidate.version.raw})</span>
                    <Badge tone="neutral">{sourceLabel(candidate.source)}</Badge>
                    <Badge tone="neutral">{bitLabel(candidate.bits)}</Badge>
                    {candidate.vendor ? <Badge tone="neutral">{candidate.vendor}</Badge> : null}
                    {isDefault ? <Badge tone="accent">默认</Badge> : null}
                  </div>
                  <div className="muted mono" style={{ marginTop: 4, wordBreak: 'break-all', fontSize: 12 }}>
                    {candidate.path}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant={isDefault ? 'secondary' : 'primary'}
                  disabled={busy || isDefault}
                  onClick={() => void makeDefault(candidate)}
                >
                  {isDefault ? '当前默认' : '设为默认'}
                </Button>
              </div>
            )
          })}
        </div>
      )}

      <div className="muted" style={{ fontSize: 12 }}>
        <Icon name="info" /> 实例级选择仍然优先：在下方「实例设置」里给某个实例单独指定 Java 时，以实例为准。
      </div>
    </div>
  )
}
