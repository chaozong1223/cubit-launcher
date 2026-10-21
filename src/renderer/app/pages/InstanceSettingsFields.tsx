import type { InstanceSettingsDraft } from '../data/useInstanceSettingsDraft'
import {
  Badge,
  Banner,
  Button,
  Field,
  Input,
  Select,
  Switch,
  Tag,
  Textarea,
} from '../ui'
import { Icon } from '../icons'

function PlanPreview({ draft }: { draft: InstanceSettingsDraft }) {
  if (draft.planLoading && !draft.plan) {
    return <div className="settings-plan settings-plan--empty"><span className="spinner" />正在生成 dry-run 启动参数…</div>
  }
  if (draft.planError) {
    return (
      <div className="settings-plan settings-plan--error">
        <Icon name="alert-circle" />
        <div><strong>{draft.planError.title}</strong><span>{draft.planError.detail}</span></div>
      </div>
    )
  }
  if (!draft.plan) {
    return <div className="settings-plan settings-plan--empty">保存后或点击“刷新 dry-run”后显示真实启动参数。</div>
  }
  const argv = draft.plan.argv
  const valueAfter = (flag: string): string | null => {
    const index = argv.indexOf(flag)
    return index >= 0 && index + 1 < argv.length ? argv[index + 1] : null
  }
  const memoryArg = (flag: '-Xms' | '-Xmx'): string | null => argv.find((arg) => arg.startsWith(flag)) ?? null
  const javaArg = argv.find((arg) => arg.toLowerCase().endsWith('java.exe') || arg.toLowerCase().endsWith('/java')) ?? draft.plan.javaPath
  const widthArg = valueAfter('--width')
  const heightArg = valueAfter('--height')
  const keyArgs = argv.filter((arg, index) =>
    arg.startsWith('-Xms') ||
    arg.startsWith('-Xmx') ||
    arg.startsWith('-D') ||
    arg === '--width' || arg === '--height' || arg === '--fullscreen' ||
    argv[index - 1] === '--width' || argv[index - 1] === '--height',
  )
  return (
    <div className="settings-plan">
      <div className="settings-plan__head">
        <div><strong><Icon name="terminal" /> dry-run 启动参数</strong><span>来自 mc:launch:plan，不启动进程</span></div>
        <div className="row gap-6">
          {draft.savedAt ? <Badge tone="success">已保存</Badge> : <Badge tone="outline">当前配置</Badge>}
          <Button size="xs" variant="ghost" icon="refresh" onClick={draft.reloadPlan} loading={draft.planLoading}>刷新</Button>
        </div>
      </div>
      <div className="settings-plan__summary">
        <span><Icon name="coffee" />{javaArg}</span>
        <span><Icon name="memory" />{memoryArg('-Xms') ?? '-Xms—'} / {memoryArg('-Xmx') ?? '-Xmx—'}</span>
        <span><Icon name="window-max" />{widthArg ?? '—'}×{heightArg ?? '—'}{argv.includes('--fullscreen') ? ' · 全屏' : ''}</span>
        <span><Icon name="folder" />{draft.plan.cwd}</span>
      </div>
      <div className="settings-plan__keys">
        {keyArgs.length ? keyArgs.map((arg) => <code key={arg}>{arg}</code>) : <span className="muted">没有可提取的 JVM/窗口参数</span>}
      </div>
      <details className="settings-plan__details">
        <summary>完整 argv（{argv.length} 项）</summary>
        <pre>{argv.join(' ')}</pre>
      </details>
      {draft.plan.warnings.length ? (
        <ul className="settings-plan__warnings">{draft.plan.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
      ) : null}
    </div>
  )
}

function JavaPicker({ draft }: { draft: InstanceSettingsDraft }) {
  const known = new Set(draft.javaCandidates.map((candidate) => candidate.path))
  return (
    <>
      <Field label="Java 选择" hint="写入实例的 java 字段；自动选择遵循版本要求，手动路径在下次 dry-run/启动生效。">
        <Select
          value={draft.javaMode === 'auto' ? 'auto' : draft.javaPath}
          onChange={(event) => {
            if (event.target.value === 'auto') {
              draft.setJavaMode('auto')
              draft.setJavaPath('')
            } else {
              draft.setJavaMode('path')
              draft.setJavaPath(event.target.value)
            }
          }}
          aria-label="Java 选择"
        >
          <option value="auto">自动选择（推荐）</option>
          {draft.javaCandidates.map((candidate) => (
            <option key={candidate.path} value={candidate.path}>
              Java {candidate.version.raw} · {candidate.source} · {candidate.path}
            </option>
          ))}
          {draft.javaPath && !known.has(draft.javaPath) ? <option value={draft.javaPath}>当前 dry-run：{draft.javaPath}</option> : null}
        </Select>
      </Field>
      {draft.javaError ? <div className="nw-inline-error">{draft.javaError.title}：{draft.javaError.detail}</div> : null}
      <div className="settings-inline-meta">
        <Badge tone={draft.javaCandidates.length ? 'success' : 'warning'}>{draft.javaLoading ? '检测中' : `${draft.javaCandidates.length} 个候选`}</Badge>
        <span>来自 java.detect 的真实候选；自动选择不伪造路径。</span>
        <Button size="xs" variant="ghost" icon="refresh" onClick={draft.reloadJava} loading={draft.javaLoading}>重新扫描</Button>
      </div>
    </>
  )
}

export function InstanceSettingsFields({ draft, mode = 'all' }: { draft: InstanceSettingsDraft; mode?: 'all' | 'java' }) {
  return (
    <div className="instance-settings-fields">
      <Banner tone="info" title="实例级设置，真实落盘">
        内存、窗口、JVM 参数和 Java 选择写入该实例的 <code className="mono">instance.json</code>；保存后会用新的 dry-run 参数刷新预览。JVM 输入框只代表实例自定义参数，启动器默认参数仍由启动链生成。
      </Banner>

      {draft.saveError ? <div className="nw-inline-error" role="alert">{draft.saveError.title}：{draft.saveError.detail}</div> : null}
      {draft.savedAt ? <Banner tone="success">实例设置已保存。dry-run 正在刷新：内存、窗口和 Java 变化会显示在下方。</Banner> : null}

      {mode === 'all' ? (
        <>
          <div className="setting-group">
            <div className="setting-group__text">
              <div className="setting-group__title">内存上下限</div>
              <div className="setting-group__desc">范围 512–65536 MB；最小值不能大于最大值。保存后 memoryMode 会变为 custom。</div>
            </div>
            <div className="setting-control settings-field-row">
              <label className="settings-mini-field"><span>最小 MB</span><Input type="number" min={512} max={65536} step={256} value={draft.minMb} onChange={(event) => draft.setMinMb(event.target.value)} aria-label="最小内存 MB" /></label>
              <label className="settings-mini-field"><span>最大 MB</span><Input type="number" min={512} max={65536} step={256} value={draft.maxMb} onChange={(event) => draft.setMaxMb(event.target.value)} aria-label="最大内存 MB" /></label>
            </div>
          </div>

          <div className="setting-group">
            <div className="setting-group__text">
              <div className="setting-group__title">游戏窗口</div>
              <div className="setting-group__desc">窗口宽 320–7680、高 240–4320；全屏标记会写入 --fullscreen。</div>
            </div>
            <div className="setting-control settings-field-row">
              <label className="settings-mini-field"><span>宽度</span><Input type="number" min={320} max={7680} step={10} value={draft.width} onChange={(event) => draft.setWidth(event.target.value)} aria-label="窗口宽度" /></label>
              <label className="settings-mini-field"><span>高度</span><Input type="number" min={240} max={4320} step={10} value={draft.height} onChange={(event) => draft.setHeight(event.target.value)} aria-label="窗口高度" /></label>
              <div className="settings-toggle-field"><Switch checked={draft.fullscreen} onChange={draft.setFullscreen} label="全屏启动" /><span>全屏启动</span></div>
            </div>
          </div>

          <div className="setting-group">
            <div className="setting-group__text">
              <div className="setting-group__title">自定义 JVM 参数</div>
              <div className="setting-group__desc">空格/引号分隔；只保存实例自定义项，例如 <code className="mono">-XX:+UseG1GC</code>。保存后写入 jvmArgs。</div>
            </div>
            <div className="setting-control">
              <Textarea rows={3} value={draft.jvmText} onChange={(event) => draft.setJvmText(event.target.value)} placeholder="-XX:+UseG1GC -XX:MaxGCPauseMillis=50" aria-label="自定义 JVM 参数" />
            </div>
          </div>
        </>
      ) : null}

      <div className="setting-group">
        <div className="setting-group__text">
          <div className="setting-group__title">Java 运行时</div>
          <div className="setting-group__desc">实例级覆盖优先于全局/自动选择；候选来自 java.detect。</div>
        </div>
        <div className="setting-control">
          <JavaPicker draft={draft} />
        </div>
      </div>

      {mode === 'java' && draft.javaCandidates.length ? (
        <div className="nw-java-list">
          {draft.javaCandidates.map((candidate) => (
            <div className="nw-java-row" key={candidate.path}>
              <span className="mono">{candidate.version.raw}</span>
              <span className="nw-java-path" title={candidate.path}>{candidate.path}</span>
              <Tag>{candidate.source}</Tag>
              <Button size="xs" variant="ghost" onClick={() => { draft.setJavaMode('path'); draft.setJavaPath(candidate.path) }}>选择</Button>
            </div>
          ))}
        </div>
      ) : null}

      <div className="settings-save-row">
        <Button variant="primary" icon="check" loading={draft.saving} onClick={() => void draft.save()}>保存实例设置</Button>
        <span className="muted">保存到 {draft.instance.dirName}/instance.json；重启后仍生效。</span>
      </div>

      <PlanPreview draft={draft} />
    </div>
  )
}
