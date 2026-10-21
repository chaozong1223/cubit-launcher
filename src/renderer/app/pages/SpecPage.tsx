import { useState } from 'react'
import {
  Badge,
  Banner,
  Button,
  Card,
  DataStateNotice,
  EmptyState,
  Field,
  Input,
  LaunchButton,
  PageHeader,
  Progress,
  SectionHead,
  Segmented,
  Select,
  Skeleton,
  Switch,
  Tag,
  cx,
} from '../ui'
import { Icon } from '../icons'

const TONES: ReadonlyArray<{ label: string; tone: 'success' | 'warning' | 'danger' | 'info' | 'accent' | 'outline' }> = [
  { label: '成功', tone: 'success' },
  { label: '警告', tone: 'warning' },
  { label: '错误', tone: 'danger' },
  { label: '信息', tone: 'info' },
  { label: '品牌', tone: 'accent' },
  { label: '轮廓', tone: 'outline' },
]

const SWATCHES: ReadonlyArray<{ name: string; value: string; note: string }> = [
  { name: 'background', value: 'var(--bg)', note: '画布' },
  { name: 'surface', value: 'var(--surface)', note: '卡片' },
  { name: 'accent', value: 'var(--accent)', note: '主操作' },
  { name: 'text', value: 'var(--text)', note: '主文字' },
  { name: 'success', value: 'var(--success)', note: '成功' },
  { name: 'warning', value: 'var(--warning-solid)', note: '警告' },
  { name: 'danger', value: 'var(--danger)', note: '错误' },
  { name: 'border', value: 'var(--border)', note: '描边' },
]

function Section({ id, title, children, note }: { id: string; title: string; children: React.ReactNode; note?: string }) {
  return (
    <Card className="spec-section" id={id}>
      <h2>{title}</h2>
      {note ? <p>{note}</p> : null}
      {children}
    </Card>
  )
}

export function SpecPage() {
  const [demoSwitch, setDemoSwitch] = useState(true)
  const [demoMode, setDemoMode] = useState<'system' | 'light' | 'dark'>('system')

  return (
    <>
      <PageHeader
        title="界面规范 · 组件与状态"
        subtitle="这是设计规范页，不是运行时页面；所有数值都是样例外壳，明确标注为样本，不进入产品数据。"
        actions={<Button variant="secondary" size="sm" icon="arrow-left" onClick={() => history.back()}>返回</Button>}
      />

      <div className="banner banner--info" style={{ marginBottom: 14 }}>
        <Icon name="flask" />
        <div className="banner__body">
          <div className="banner__title">设计样本，不是真实数据</div>
          <div>产品页面只显示 IPC 真实返回或明确的“尚未接入后端”；本页用于核对组件尺寸、间距、色板与状态机。</div>
        </div>
      </div>

      <Section id="spec-color" title="色彩" note="同一语义令牌在浅色/深色下切换；色块使用当前主题的真实 CSS 变量。">
        <div className="swatch-grid">
          {SWATCHES.map((swatch) => (
            <div className="swatch" key={swatch.name}>
              <div className="swatch__color" style={{ background: swatch.value }} />
              <div className="swatch__meta">
                <div className="swatch__name">{swatch.name}</div>
                <div className="swatch__hex">{swatch.note}</div>
              </div>
            </div>
          ))}
        </div>
        <div className="spec-sub">语义徽章</div>
        <div className="demo-row">
          {TONES.map((item) => <Badge key={item.tone} tone={item.tone}>{item.label}</Badge>)}
          <Badge tone="success" dot>已连接</Badge>
          <Badge tone="warning" dot>等待后端</Badge>
        </div>
        <div className="spec-sub">加载器标签</div>
        <div className="demo-row">
          <Tag variant="vanilla">原版</Tag>
          <Tag variant="forge">Forge</Tag>
          <Tag variant="neo">NeoForge</Tag>
          <Tag variant="fabric">Fabric</Tag>
          <Tag variant="pack">Quilt</Tag>
        </div>
      </Section>

      <Section id="spec-type" title="字阶" note="正文 13/20；标题 22/28；等宽 12/20。数字使用 tabular-nums。">
        <div className="type-specimen">
          <div className="type-row"><div className="type-row__sample display">启动游戏，继续冒险</div><div className="type-row__meta">Display 28/34 · 600</div></div>
          <div className="type-row"><div className="type-row__sample h1">欢迎回来</div><div className="type-row__meta">H1 22/28 · 600</div></div>
          <div className="type-row"><div className="type-row__sample h2">最近游玩</div><div className="type-row__meta">H2 17/24 · 600</div></div>
          <div className="type-row"><div className="type-row__sample body">实例数据来自真实 IPC；未接入时显示明确状态。</div><div className="type-row__meta">Body 13/20 · 400</div></div>
          <div className="type-row"><div className="type-row__sample caption">Caption 12/16 · 辅助说明</div><div className="type-row__meta">Caption 12/16</div></div>
          <div className="type-row"><div className="type-row__sample mono">mc:instance:list · blocked channel</div><div className="type-row__meta">Mono 12/20</div></div>
        </div>
      </Section>

      <Section id="spec-buttons" title="按钮" note="每个视图最多一个主按钮；禁用/加载态仍然保留原宽度，文案说明正在发生什么。">
        <div className="demo-row">
          <Button variant="primary" icon="play">主按钮</Button>
          <Button variant="secondary" icon="folder">次按钮</Button>
          <Button variant="ghost">幽灵按钮</Button>
          <Button variant="subtle">弱强调</Button>
          <Button variant="danger">危险操作</Button>
          <Button variant="danger-ghost">危险幽灵</Button>
          <Button variant="link">文字链接</Button>
        </div>
        <div className="spec-sub">尺寸与状态</div>
        <div className="demo-row">
          <Button size="xs" variant="primary">XS 24</Button>
          <Button size="sm" variant="primary">SM 28</Button>
          <Button variant="primary">MD 32</Button>
          <Button size="lg" variant="primary">LG 40</Button>
          <Button variant="primary" disabled>禁用</Button>
          <Button variant="primary" loading>加载中</Button>
          <Button variant="ghost" icon="more" aria-label="更多" />
        </div>
      </Section>

      <Section id="spec-forms" title="表单控件" note="输入框 32 高；标签 12/600；错误解释紧贴字段，不使用整页弹窗。">
        <div className="demo-grid">
          <div className="form-demo">
            <Field label="实例名称" hint="真实输入会写入 instance 后端；本页仅为控件样本"><Input placeholder="输入实例名称" /></Field>
            <Field label="搜索" hint="图标在左，输入占位为 text-3"><div className="input-wrap"><Icon name="search" /><Input placeholder="搜索实例、版本或加载器" /></div></Field>
            <Field label="Java 运行时" hint="下拉选项来自 java.detect"><Select aria-label="Java 运行时"><option>等待检测结果</option></Select></Field>
            <Field label="错误示例" error="该路径不存在。请重新选择。"><Input className="is-invalid" defaultValue="/missing/java" /></Field>
            <Field label="JVM 参数" hint="多行文本，支持回车换行"><textarea className="textarea" rows={2} defaultValue="-XX:+UseG1GC" /></Field>
          </div>
          <div className="form-demo">
            <div className="setting-group" style={{ border: 0, padding: 0 }}>
              <div className="setting-group__text"><div className="setting-group__title">自动分配内存</div><div className="setting-group__desc">开关是即时 UI，落盘由设置后端。</div></div>
              <div className="setting-control"><Switch checked={demoSwitch} onChange={setDemoSwitch} label="自动分配内存样本" /></div>
            </div>
            <div className="demo-row"><span className="demo-label">分段</span><Segmented value={demoMode} options={[{ value: 'system', label: '跟随系统' }, { value: 'light', label: '浅色' }, { value: 'dark', label: '深色' }]} onChange={setDemoMode} ariaLabel="主题样本" /></div>
            <div className="demo-row"><span className="demo-label">复选框</span><label className="check-row"><input className="check" type="checkbox" defaultChecked />启动后隐藏启动器</label><label className="check-row"><input className="check" type="checkbox" />诊断模式</label></div>
            <div className="demo-row"><span className="demo-label">单选</span><label className="check-row"><input className="radio" type="radio" name="demo-radio" defaultChecked />自动选择</label><label className="check-row"><input className="radio" type="radio" name="demo-radio" />手动指定</label></div>
            <div className="demo-row"><span className="demo-label">滑块</span><input className="slider" type="range" min={0} max={100} defaultValue={56} aria-label="滑块样本" /></div>
            <div className="demo-row"><span className="demo-label">步进器</span><div className="stepper"><button type="button">−</button><input defaultValue={8} aria-label="步进器样本" /><button type="button">+</button></div></div>
          </div>
        </div>
      </Section>

      <Section id="spec-feedback" title="反馈组件" note="进度必须同时给出总量/速度/剩余中的至少两项；示例数字明确属于设计样本。">
        <div className="demo-grid">
          <div>
            <div className="spec-sub">进度条</div>
            <div className="setting-group" style={{ border: 0, display: 'block', padding: '8px 0' }}>
              <Progress value={56} label="设计样本进度 56%" />
              <div className="progress-meta"><span>设计样本 56%</span><span>样本 1.8 / 3.2 GB</span></div>
            </div>
            <div className="setting-group" style={{ border: 0, display: 'block', padding: '8px 0' }}>
              <Progress value={100} tone="success" label="设计样本完成" />
              <div className="progress-meta"><span>校验通过</span><span>100%</span></div>
            </div>
            <div className="setting-group" style={{ border: 0, display: 'block', padding: '8px 0' }}>
              <Progress label="设计样本不确定进度" />
              <div className="progress-meta"><span>正在分析…</span><span>未知时长</span></div>
            </div>
            <div className="spec-sub">骨架屏</div>
            <div className="mini-frame" style={{ padding: 12 }}>
              <Skeleton className="skeleton--title" style={{ width: '46%' }} />
              <Skeleton className="skeleton--text" style={{ width: '78%', marginTop: 8 }} />
              <Skeleton className="skeleton--text" style={{ width: '62%', marginTop: 8 }} />
            </div>
          </div>
          <div>
            <div className="spec-sub">提示条</div>
            <Banner tone="success" title="检查通过">版本文件、Java 与资源均正常。</Banner>
            <div style={{ height: 8 }} />
            <Banner tone="warning" title="模组清单不一致">加入前会被拦截，并列出差异。</Banner>
            <div style={{ height: 8 }} />
            <Banner tone="danger" title="实例读取失败">检查目录后重试。</Banner>
            <div style={{ height: 8 }} />
            <Banner tone="info" title="信息提示">这里不会出现虚构的延迟或在线人数。</Banner>
            <div className="spec-sub">空状态</div>
            <div className="mini-frame">
              <EmptyState icon="flask" title="尚未接入后端" description="真实数据到位后自动显示。" />
            </div>
          </div>
        </div>
      </Section>

      <Section id="spec-states" title="启动按钮 · 6 种状态" note="产品页只在真实状态源可用时切换；不可用状态会显示“待接入”，不伪造运行中。">
        <div className="state-grid">
          {([
            ['not-installed', '未安装', '点击进入安装；不会启动不存在的版本。'],
            ['ready', '就绪', '唯一主操作；点击后由 launch.start 驱动。'],
            ['installing', '安装中', '显示 spinner 与阶段；不可重复点击。'],
            ['launching', '启动中', '等待进程派生；不因点击成功就显示运行中。'],
            ['running', '运行中', '显示计时与结束入口；状态来自 launch.status 事件。'],
            ['crashed', '崩溃', '异常退出；显示报告入口，不恐吓。'],
          ] as const).map(([state, title, desc]) => (
            <div className="state-card" key={state}>
              <div className="state-card__preview"><LaunchButton state={state} /></div>
              <div className="state-card__name">{title} <code>{state}</code></div>
              <div className="state-card__desc">{desc}</div>
            </div>
          ))}
        </div>
      </Section>

      <Section id="spec-download" title="下载/联机状态机（设计样本）" note="这些是状态定义与文案样本，不是运行时任务数据。">
        <div className="download-state-grid">
          {[
            ['等待中', 'outline', '等待带宽释放'],
            ['下载中', 'accent', '总量 / 速度 / 剩余'],
            ['校验中', 'info', 'SHA1/SHA256 通过后才完成'],
            ['已暂停', 'warning', '断点保留'],
            ['失败', 'danger', '重试 / 换源'],
            ['已完成', 'success', '可启动'],
          ].map(([label, tone, detail]) => (
            <div className="mini-task" key={label as string}>
              <div className="mini-task__head">
                <div><div className="mini-task__name">下载状态样本</div><div className="mini-task__sub">{detail}</div></div>
                <Badge tone={tone as 'accent'} dot>{label}</Badge>
              </div>
              <Progress value={label === '下载中' ? 56 : label === '已完成' ? 100 : undefined} tone={label === '失败' ? 'danger' : label === '已完成' ? 'success' : 'accent'} label={`${label}样本`} />
              <div className="mini-task__meta"><span>{label === '下载中' ? '样本 56%' : '等待真实事件'}</span><span>{label === '下载中' ? '样本 12.4 MB/s' : '—'}</span></div>
            </div>
          ))}
        </div>
      </Section>

      <Section id="spec-copy" title="错误与提示文案" note="三句话：发生了什么 → 影响 → 下一步。技术码放详情，不放进标题。">
        <div className="do-dont">
          <div className="copy-example copy-example--bad"><h4>不要这样写</h4><div><code>启动失败：Error: spawn ENOENT</code></div><ul><li>只有原始异常</li><li>没有下一步</li></ul></div>
          <div className="copy-example copy-example--good"><h4>这样写</h4><div><strong>找不到 Java 21</strong></div><div>这个实例需要 Java 21。可以自动下载，或手动选择已安装的 Java。</div><ul><li>主操作：下载 Java 21</li><li>次操作：选择已有 Java</li></ul></div>
          <div className="copy-example copy-example--bad"><h4>不要这样写</h4><div><strong>游戏崩溃了！！！</strong></div><div>请把截图发给我们。</div></div>
          <div className="copy-example copy-example--good"><h4>这样写</h4><div><strong>游戏异常退出（返回码 1）</strong></div><div>可能缺少前置模组。查看报告 / 重新启动。</div></div>
        </div>
      </Section>

      <Section id="spec-nw" title="尚未接入状态" note="这是本阶段真实页面的标准状态；不会用示例实例、任务或账号数据填充。">
        <DataStateNotice
          info={{
            kind: 'not-wired',
            title: '真实数据尚未接入后端',
            detail: 'preload 白名单尚未放行模块通道；页面保留完整布局与操作位置。',
            channel: 'mc:instance:list',
            code: 'UI.NOT_WIRED',
            retryable: false,
            feature: '实例数据',
          }}
          onRetry={() => undefined}
        />
      </Section>
    </>
  )
}
