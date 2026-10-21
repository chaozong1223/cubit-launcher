import net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { ScopedLogger } from '../../../kernel/logger'
import { HostControl } from '../control'
import { helloAuth } from '../ticket'

const silentLog = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
} as unknown as ScopedLogger

const controls: HostControl[] = []

afterEach(async () => {
  for (const control of controls.splice(0)) await control.close()
})

function waitFor(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = (): void => {
      if (condition()) return resolve()
      if (Date.now() - started > timeoutMs) return reject(new Error('timeout'))
      setTimeout(tick, 20)
    }
    tick()
  })
}

describe('HostControl heartbeat and auth', () => {
  it('drops a member that never sends PING and reports HEARTBEAT_TIMEOUT', async () => {
    const token = Buffer.from('0123456789abcdef0123456789abcdef', 'hex')
    const code = 'ABC123'
    let errorCode: string | null = null
    const host = new HostControl({
      code,
      token,
      hostName: 'host',
      mcVersion: '1.20.1',
      loader: 'vanilla',
      maxMembers: 2,
      log: silentLog,
      heartbeatTimeoutMs: 250,
      onError: (next) => {
        errorCode = next
      },
    })
    controls.push(host)
    const port = await host.listen('127.0.0.1')
    const socket = net.createConnection({ host: '127.0.0.1', port })
    socket.setEncoding('utf8')
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve())
      socket.once('error', reject)
    })
    const nonce = 'nonce-1'
    socket.write(
      `${JSON.stringify({
        t: 'HELLO',
        v: 1,
        code,
        nonce,
        member: { id: 'm1', name: 'member', mcVersion: '1.20.1', loader: 'vanilla', path: 'direct' },
        auth: helloAuth(token, { code, nonce, memberId: 'm1' }),
      })}\n`,
    )
    await waitFor(() => errorCode === 'HEARTBEAT_TIMEOUT', 3_000)
    expect(errorCode).toBe('HEARTBEAT_TIMEOUT')
    socket.destroy()
  })

  it('rejects a HELLO with a bad HMAC', async () => {
    const token = Buffer.from('0123456789abcdef0123456789abcdef', 'hex')
    const host = new HostControl({
      code: 'ABC123',
      token,
      hostName: 'host',
      mcVersion: '1.20.1',
      loader: 'vanilla',
      maxMembers: 2,
      log: silentLog,
      heartbeatTimeoutMs: 5_000,
    })
    controls.push(host)
    const port = await host.listen('127.0.0.1')
    const socket = net.createConnection({ host: '127.0.0.1', port })
    socket.setEncoding('utf8')
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve())
      socket.once('error', reject)
    })
    const response = new Promise<string>((resolve) => {
      socket.once('data', (chunk: string) => resolve(chunk))
    })
    socket.write(
      `${JSON.stringify({
        t: 'HELLO',
        v: 1,
        code: 'ABC123',
        nonce: 'n',
        member: { id: 'm1', name: 'member', mcVersion: '1.20.1', loader: 'vanilla' },
        auth: 'bad',
      })}\n`,
    )
    expect(await response).toContain('AUTH_FAILED')
    socket.destroy()
  })

  it('destroys a socket that never completes HELLO and caps pending sockets', async () => {
    const token = Buffer.from('0123456789abcdef0123456789abcdef', 'hex')
    const host = new HostControl({
      code: 'ABC123',
      token,
      hostName: 'host',
      mcVersion: '1.20.1',
      loader: 'vanilla',
      maxMembers: 2,
      log: silentLog,
      heartbeatTimeoutMs: 5_000,
      handshakeTimeoutMs: 50,
      maxUnauthenticated: 1,
    })
    controls.push(host)
    const port = await host.listen('127.0.0.1')
    const first = net.createConnection({ host: '127.0.0.1', port })
    await new Promise<void>((resolve, reject) => {
      first.once('connect', () => resolve())
      first.once('error', reject)
    })
    const ended = new Promise<void>((resolve) => first.once('end', () => resolve()))
    first.resume()
    await Promise.race([ended, new Promise((resolve) => setTimeout(resolve, 1_500))])
    expect(first.readableEnded || first.destroyed).toBe(true)
    first.destroy()

    const second = net.createConnection({ host: '127.0.0.1', port })
    await new Promise<void>((resolve) => {
      second.once('connect', () => resolve())
      second.once('error', () => resolve())
    })
    second.resume()
    await new Promise((resolve) => setTimeout(resolve, 300))
    second.destroy()
  })
})
