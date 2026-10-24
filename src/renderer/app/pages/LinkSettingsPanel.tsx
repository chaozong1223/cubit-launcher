import { useEffect, useState } from 'react'
import type { NetSettings } from '@shared/net'
import { useBackend } from '../data/BackendContext'
import { describeError } from '../data/backend'
import { useAsync } from '../data/useAsync'
import { Badge, Button, DataStateNotice, EmptyState, Field, Input, Switch } from '../ui'
import { Icon } from '../icons'

const RELAY_PATTERN = /^(?:tcp|udp):\/\/[^\s/:]+:\d{1,5}$/

/**
 * 设置 → 联机.
 *
 * Everything here is real: the values come from `net.settings`, are written to
 * `dataRoot/modules/net/config.json`, and take effect on the next invite. The
 * page is deliberately honest about what a public address can and cannot do —
 * an endpoint only helps when the host is actually reachable on that port.
 */
export function LinkSettingsPanel() {
  const backend = useBackend()
  const settings = useAsync(() => backend.link.settings(), [])
  const [manualIp, setManualIp] = useState('')
  const [relays, setRelays] = useState<string[]>([])
  const [relayDraft, setRelayDraft] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [relayTests, setRelayTests] = useState<Record<string, { ok: boolean; detail: string }>>({})

  const data: NetSettings | null = settings.data ?? null

  useEffect(() => {
    if (!data) return
    setManualIp(data.manualPublicIp ?? '')
    setRelays(data.relayPeers)
  }, [data])

  const pending = settings.status === 'not-wired' || settings.status === 'error'
  const info = pending ? describeError(settings.error) : null

  const run = async (label: string, action: () => Promise<NetSettings | void>): Promise<boolean> => {
    setBusy(label)
    setError(null)
    setNotice(null)
    try {
      await action()
      settings.reload()
      return true
    } catch (cause) {
      setError(`${describeError(cause).title}：${describeError(cause).detail}`)
      return false
    } finally {
      setBusy(null)
    }
  }

  const saveManualIp = () =>
    run('save-ip', async () => {
      const result = await backend.link.updateSettings({ manualPublicIp: manualIp.trim() })
      setNotice(
        result.manualPublicIp
          ? `已保存公网地址 ${result.manualPublicIp}，下次生成邀请码时会写入 WAN 端点。`
          : '已清除手动公网地址，改为使用自动探测结果。',
      )
    })

  const toggleAutoProbe = (enabled: boolean) =>
    run('auto-probe', async () => {
      const result = await backend.link.updateSettings({ autoProbe: enabled })
      setNotice(enabled ? '已开启自动探测。' : '已关闭自动探测；邀请码只含局域网地址，除非手动填写。')
      return result
    })

  const probeNow = async () => {
    setBusy('probe')
    setError(null)
    setNotice(null)
    try {
      const result = await backend.link.probePublicIp()
      setNotice(result.ip ? `探测结果：${result.ip}（${result.detail}）` : `未探测到公网地址：${result.detail}`)
      settings.reload()
    } catch (cause) {
      const ui = describeError(cause)
      setError(`${ui.title}：${ui.detail}`)
    } finally {
      setBusy(null)
    }
  }

  const addRelay = () => {
    const peer = relayDraft.trim()
    if (!RELAY_PATTERN.test(peer)) {
      setError('中继地址格式应为 tcp://host:port（例如 tcp://relay.example.com:11010）。')
      return
    }
    if (relays.includes(peer)) {
      setError('这个中继节点已经在列表里。')
      return
    }
    if (relays.length >= 4) {
      setError('最多配置 4 个中继节点。')
      return
    }
    setRelayDraft('')
    void run('add-relay', async () => {
      const result = await backend.link.updateSettings({ relayPeers: [...relays, peer] })
      setNotice(`已加入中继 ${peer}。`)
      setRelays(result.relayPeers)
    })
  }

  const removeRelay = (peer: string) =>
    void run('remove-relay', async () => {
      const next = relays.filter((item) => item !== peer)
      const result = await backend.link.updateSettings({ relayPeers: next })
      setRelays(result.relayPeers)
      setRelayTests((current) => {
        const copy = { ...current }
        delete copy[peer]
        return copy
      })
      setNotice(`已移除中继 ${peer}。`)
    })

  const testRelay = async (peer: string) => {
    setBusy(`test:${peer}`)
    try {
      const result = await backend.link.testRelay({ peer })
      setRelayTests((current) => ({ ...current, [peer]: { ok: result.ok, detail: result.detail } }))
    } catch (cause) {
      const ui = describeError(cause)
      setRelayTests((current) => ({ ...current, [peer]: { ok: false, detail: `${ui.title}：${ui.detail}` } }))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="settings-section">
      <div className="settings-section__head">
        <div>
          <h2>联机</h2>
          <p>
            公网地址与中继写入数据目录的 <code className="mono">modules/net/config.json</code>；
            改动会在下一次生成邀请码时生效，正在进行的房间会立刻重新签发邀请码。
          </p>
        </div>
      </div>
      <div className="settings-section__body">
        {info ? <DataStateNotice info={info} onRetry={settings.reload} /> : null}

        {!data && !pending ? (
          <EmptyState icon="link" title="正在读取联机设置" description="设置来自 net 模块的真实配置，不会显示示例值。" />
        ) : null}

        {data ? (
          <>
            <div className="setting-group setting-group--stack">
              <div className="setting-group__text">
                <div className="setting-group__title">
                  公网地址
                  {data.manual ? <Badge tone="accent">手动</Badge> : data.detectedPublicIp ? <Badge tone="success">自动探测</Badge> : <Badge tone="warning">未设置</Badge>}
                </div>
                <div className="setting-group__desc">
                  朋友跨网加入时，邀请码里的 WAN 端点就是「公网地址 : 隧道端口」。填 IPv4 或域名（DDNS），
                  不要带 <code className="mono">tcp://</code> 或端口。留空表示使用自动探测结果。
                </div>
              </div>
              <div className="link-settings-row">
                <Field label="公网地址" hint="例如 114.247.65.90 或 myhome.example.com">
                  <Input
                    value={manualIp}
                    onChange={(event) => setManualIp(event.target.value)}
                    placeholder={data.detectedPublicIp ?? '留空则使用自动探测'}
                    aria-label="公网地址"
                  />
                </Field>
                <div className="link-settings-row__actions">
                  <Button size="sm" variant="primary" loading={busy === 'save-ip'} disabled={busy !== null} onClick={() => void saveManualIp()}>
                    保存
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon="refresh"
                    loading={busy === 'probe'}
                    disabled={busy !== null}
                    onClick={() => void probeNow()}
                  >
                    立即探测
                  </Button>
                </div>
              </div>
              <div className="link-settings-facts">
                <span>
                  <Icon name="network" />有效地址
                  <strong className="mono">{data.effectivePublicIp ?? '未确定'}</strong>
                </span>
                <span>
                  <Icon name="activity" />隧道端口
                  <strong className="mono">{data.wanPort ?? '房间未开房或隧道未启动'}</strong>
                </span>
                <span>
                  <Icon name="wifi" />局域网地址
                  <strong className="mono">{data.lanIp}</strong>
                </span>
              </div>
              {data.probeDetail ? <div className="link-settings-note">{data.probeDetail}</div> : null}
              <div className="link-settings-note link-settings-note--warn">
                公网地址只有在「这个端口真的能从外网连进来」时才有用：需要路由器端口映射，或本机直接持有公网 IP。
                运营商 CGNAT（100.64.0.0/10）下没有端口映射可用，必须搭中继。
              </div>
            </div>

            <div className="setting-group">
              <div className="setting-group__text">
                <div className="setting-group__title">自动探测公网地址</div>
                <div className="setting-group__desc">
                  开房后先问 EasyTier（STUN 结果），失败再请求 <code className="mono">ip.3322.net</code> /{' '}
                  <code className="mono">icanhazip.com</code> / <code className="mono">api.ipify.org</code> 取出口地址。
                  探测不到时会写明原因，不再静默降级成只有局域网。
                </div>
              </div>
              <div className="setting-control">
                <Switch
                  checked={data.autoProbe}
                  onChange={(enabled) => void toggleAutoProbe(enabled)}
                  label="自动探测公网地址"
                  disabled={busy !== null}
                />
              </div>
            </div>

            <div className="setting-group setting-group--stack">
              <div className="setting-group__text">
                <div className="setting-group__title">中继节点 <Badge tone="outline">{relays.length}/4</Badge></div>
                <div className="setting-group__desc">
                  双方都无法直连时（典型是 CGNAT），EasyTier 需要一台公网机器做中继：
                  <code className="mono">easytier-core -l tcp://0.0.0.0:11010</code>，
                  然后把 <code className="mono">tcp://你的机器:11010</code> 填到这里。房主和成员都要配同一个。
                </div>
              </div>
              <div className="link-settings-row">
                <Field label="新增中继" hint="格式 tcp://host:11010，最多 4 个">
                  <Input
                    value={relayDraft}
                    onChange={(event) => setRelayDraft(event.target.value)}
                    placeholder="tcp://relay.example.com:11010"
                    aria-label="新增中继节点"
                  />
                </Field>
                <div className="link-settings-row__actions">
                  <Button size="sm" variant="secondary" icon="link" loading={busy === 'add-relay'} disabled={busy !== null} onClick={addRelay}>
                    添加
                  </Button>
                </div>
              </div>
              {relays.length === 0 ? (
                <div className="link-settings-note">还没有中继节点。局域网直连不需要中继。</div>
              ) : (
                <div className="link-settings-list">
                  {relays.map((peer) => {
                    const tested = relayTests[peer]
                    return (
                      <div className="link-settings-list__row" key={peer}>
                        <span className="mono">{peer}</span>
                        {tested ? (
                          <Badge tone={tested.ok ? 'success' : 'danger'} dot>{tested.ok ? '可连接' : '不可达'}</Badge>
                        ) : (
                          <Badge tone="outline">未测试</Badge>
                        )}
                        {tested && !tested.ok ? <span className="muted">{tested.detail}</span> : null}
                        <div className="row gap-8">
                          <Button
                            size="xs"
                            variant="ghost"
                            icon="activity"
                            loading={busy === `test:${peer}`}
                            disabled={busy !== null}
                            onClick={() => void testRelay(peer)}
                          >
                            测试
                          </Button>
                          <Button
                            size="xs"
                            variant="danger-ghost"
                            icon="close"
                            disabled={busy !== null}
                            onClick={() => void removeRelay(peer)}
                          >
                            移除
                          </Button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            <div className="setting-group">
              <div className="setting-group__text">
                <div className="setting-group__title">房间上限</div>
                <div className="setting-group__desc">含房主在内最多 {data.maxMembers} 人；由模块配置固定，暂不在界面上改。</div>
              </div>
              <div className="setting-control">
                <Badge tone="outline">{data.maxMembers} 人</Badge>
              </div>
            </div>

            {notice ? <div className="link-settings-note link-settings-note--ok">{notice}</div> : null}
            {error ? <div className="nw-inline-error">{error}</div> : null}
          </>
        ) : null}
      </div>
    </div>
  )
}
