import { execFile } from 'node:child_process'
import net from 'node:net'
import { isPublicIpv4 } from './netutil'

/**
 * Public-address discovery for the host side of a link room (docs/12 §4).
 *
 * Two sources, in order:
 *
 * 1. `easytier-cli node` against the running sidecar — the address EasyTier
 *    itself learned through STUN. This is the authoritative answer when it
 *    works, because it is the address the tunnel is actually reachable on.
 * 2. An HTTPS echo service in the main process. In the packaged build the CLI
 *    returned an empty table (empty stdout, exit 0) while the same command
 *    worked in PowerShell, so the probe kept degrading every invite to
 *    LAN-only without any visible error. A second, independent source removes
 *    that single point of failure.
 *
 * Neither source is trusted blindly: the result must parse as an IPv4 literal.
 * CGNAT / private addresses are reported as such instead of being published.
 */

export interface ProbeLog {
  info(message: string, details?: Record<string, unknown>): void
  warn(message: string, details?: Record<string, unknown>): void
}

export interface CliResult {
  stdout: string
  stderr: string
  code: number | null
  error: string | null
}

export interface ProbeDeps {
  log: ProbeLog
  /** Path to `easytier-cli.exe`; null skips the CLI source. */
  cliPath?: string | null
  /** RPC portal port of the running sidecar; 0/null skips the CLI source. */
  rpcPort?: number | null
  /** Test seams. */
  runCli?: (cliPath: string, args: string[]) => Promise<CliResult>
  fetchText?: (url: string) => Promise<string>
  timeoutMs?: number
}

export interface PublicIpResult {
  ip: string | null
  detail: string
  source: 'manual' | 'cli' | 'echo' | 'none'
}

/** Echo services, most reachable first on mainland networks. */
export const IP_ECHO_URLS: readonly string[] = [
  'https://ip.3322.net',
  'https://ipv4.icanhazip.com',
  'https://api.ipify.org',
]

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/

/** True for a dotted quad whose octets are all in range. */
export function isIpv4Literal(value: string): boolean {
  if (!IPV4.test(value)) return false
  return value.split('.').every((part) => Number(part) <= 255)
}

/**
 * Pull the addresses out of `easytier-cli node`'s table. EasyTier prints one
 * `Public IPv4` row per configured listener; the order is unspecified, so the
 * caller decides which of them to publish.
 */
export function parseCliNodeOutput(text: string): string[] {
  const found: string[] = []
  for (const match of text.matchAll(/Public\s+IPv4\s*[|:]\s*([0-9.]+)/g)) {
    const ip = match[1] ?? ''
    if (isIpv4Literal(ip) && !found.includes(ip)) found.push(ip)
  }
  return found
}

/**
 * An echo service answers with a bare address in the common case
 * (`ip.3322.net`, `icanhazip.com`) but some wrap it in a sentence —
 * `Current IP Address: 1.2.3.4` or `当前 IP：1.2.3.4 来自于：…`. Accept a known
 * prefix, and accept a single unambiguous address inside a short body; anything
 * longer is treated as a page, not an answer.
 */
export function parseIpEcho(body: string): string | null {
  const text = body.trim()
  if (text.length === 0 || text.length > 400) return null
  const cleaned = text
    .replace(/^ip=/i, '')
    .replace(/^(?:Current\s+IP\s+Address|当前\s*IP)\s*[:：]\s*/i, '')
    .trim()
  if (isIpv4Literal(cleaned)) return cleaned
  // Markup and JSON are pages, not answers — even if they happen to embed an
  // address (a captive-portal page must not become "your public IP").
  if (/[<>{}"]/.test(cleaned)) return null
  const tokens = [...new Set(cleaned.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) ?? [])]
  const first = tokens[0]
  return tokens.length === 1 && first && isIpv4Literal(first) ? first : null
}

function defaultRunCli(timeoutMs: number) {
  return (cliPath: string, args: string[]): Promise<CliResult> =>
    new Promise((resolve) => {
      execFile(
        cliPath,
        args,
        { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' },
        (error, stdout, stderr) => {
          const rawCode = (error as { code?: unknown } | null)?.code
          resolve({
            stdout: String(stdout ?? ''),
            stderr: String(stderr ?? ''),
            // `code` is the exit status for a non-zero exit and a string
            // (ENOENT, ETIMEDOUT, ...) when the process never ran.
            code: error ? (typeof rawCode === 'number' ? rawCode : null) : 0,
            error: error ? error.message : null,
          })
        },
      )
    })
}

async function defaultFetchText(url: string, timeoutMs: number): Promise<string> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: 'text/plain' },
    redirect: 'error',
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return await response.text()
}

/**
 * Resolve the host's public IPv4 through the first source that answers.
 * Never throws: an empty result comes back with the reason in `detail`.
 */
export async function probePublicIpv4(deps: ProbeDeps): Promise<PublicIpResult> {
  const timeoutMs = deps.timeoutMs ?? 8_000
  const runCli = deps.runCli ?? defaultRunCli(timeoutMs)
  const fetchText = deps.fetchText ?? ((url: string) => defaultFetchText(url, timeoutMs))
  const notes: string[] = []

  if (deps.cliPath && deps.rpcPort) {
    try {
      const result = await runCli(deps.cliPath, [
        '--rpc-portal',
        `127.0.0.1:${deps.rpcPort}`,
        'node',
      ])
      const candidates = parseCliNodeOutput(result.stdout)
      deps.log.info('public ip probe', {
        source: 'cli',
        exitCode: result.code,
        candidates,
        stderr: result.stderr.trim().slice(0, 200),
      })
      const picked = candidates.find((ip) => isPublicIpv4(ip)) ?? candidates[0] ?? null
      if (picked) {
        return {
          ip: picked,
          source: 'cli',
          detail: isPublicIpv4(picked)
            ? '来自 EasyTier 的 STUN 结果'
            : `${picked} 不是公网地址（运营商 CGNAT？），跨网仍需中继或端口映射`,
        }
      }
      notes.push(
        result.error
          ? `easytier-cli 失败：${result.error}`
          : `easytier-cli 未报告公网地址（exit ${result.code ?? '?'}）`,
      )
    } catch (error) {
      notes.push(`easytier-cli 异常：${messageOf(error)}`)
    }
  } else {
    notes.push('隧道未启动，跳过 easytier-cli')
  }

  for (const url of IP_ECHO_URLS) {
    try {
      const body = await fetchText(url)
      const ip = parseIpEcho(body)
      if (ip) {
        deps.log.info('public ip probe', { source: 'echo', url, ip })
        return {
          ip,
          source: 'echo',
          detail: isPublicIpv4(ip)
            ? `来自 ${url}`
            : `${ip} 不是公网地址（运营商 CGNAT？），跨网仍需中继或端口映射`,
        }
      }
      notes.push(`${url} 返回了无法识别的内容`)
    } catch (error) {
      notes.push(`${url} 不可达：${messageOf(error)}`)
    }
  }

  deps.log.warn('public ip probe gave up', { notes })
  return { ip: null, source: 'none', detail: notes.join('；') }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * One-shot TCP reachability check for a relay peer. EasyTier relays are plain
 * TCP listeners (`tcp://host:11010`), so a handshake is enough to tell "wrong
 * address" from "network blocked".
 */
export async function testRelayTcp(
  peer: string,
  options: { timeoutMs?: number; connect?: (host: string, port: number, timeoutMs: number) => Promise<void> } = {},
): Promise<{ ok: boolean; rttMs: number | null; detail: string }> {
  const parsed = /^(?:tcp|udp):\/\/([^/:]+):(\d{1,5})$/.exec(peer.trim())
  if (!parsed) return { ok: false, rttMs: null, detail: '中继地址格式应为 tcp://host:port' }
  const host = parsed[1] as string
  const port = Number(parsed[2])
  const timeoutMs = options.timeoutMs ?? 4_000
  const connect = options.connect ?? defaultTcpConnect
  const started = Date.now()
  try {
    await connect(host, port, timeoutMs)
    return { ok: true, rttMs: Date.now() - started, detail: `${host}:${port} 可连接` }
  } catch (error) {
    return { ok: false, rttMs: null, detail: `${host}:${port} 连接失败：${messageOf(error)}` }
  }
}

async function defaultTcpConnect(host: string, port: number, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = net.connect({ host, port })
    const finish = (error?: Error): void => {
      socket.removeAllListeners()
      socket.destroy()
      if (error) reject(error)
      else resolve()
    }
    socket.setTimeout(timeoutMs, () => finish(new Error('超时')))
    socket.once('connect', () => finish())
    socket.once('error', (error) => finish(error))
  })
}
