import { describe, expect, it } from 'vitest'
import {
  createRoomIdentity,
  issueTicket,
  parseTicket,
  deriveCode,
  shortInvite,
  type TicketTunnel,
} from '../ticket'

const tunnel: TicketTunnel = {
  provider: 'easytier',
  version: '2.7.0',
  vip: '10.144.144.1',
  mappedCidr: '192.168.77.1/32',
  worldPort: 25565,
  controlPort: 25998,
  peerPort: 11010,
  lanControlPort: 25999,
}

function identity(): ReturnType<typeof createRoomIdentity> {
  return createRoomIdentity({
    hostName: 'poc-host',
    mcVersion: '1.20.1',
    loader: 'vanilla',
    maxMembers: 8,
  })
}

describe('invite ticket', () => {
  it('round-trips, derives the 6-char code and verifies the signature', () => {
    const room = identity()
    expect(room.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/)
    expect(deriveCode(room.roomId)).toBe(room.code)
    expect(shortInvite(room.code)).toBe(`MCL-${room.code}`)

    const issued = issueTicket({
      identity: room,
      endpoints: [{ kind: 'lan', host: '10.1.2.3', port: 25999 }],
      tunnel,
      now: 1_800_000_000,
      ttlSeconds: 600,
    })
    expect(issued.ticket.startsWith('MCL1.')).toBe(true)
    expect(issued.ticket).not.toContain(room.netSecret.toString('base64url'))

    const parsed = parseTicket(issued.ticket, { now: 1_800_000_100 })
    expect(parsed.payload.code).toBe(room.code)
    expect(parsed.payload.tunnel.worldPort).toBe(25565)
    expect(parsed.payload.endpoints[0]).toEqual({ kind: 'lan', host: '10.1.2.3', port: 25999 })
    expect(parsed.payload.net.secret).toBe(room.netSecret.toString('base64url'))
  })

  it('rejects a modified payload (tamper)', () => {
    const room = identity()
    const issued = issueTicket({
      identity: room,
      endpoints: [{ kind: 'lan', host: '10.1.2.3', port: 25999 }],
      tunnel,
      now: 1_800_000_000,
    })
    const [prefix, code, payload, signature] = issued.ticket.split('.')
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      tunnel: { worldPort: number }
    }
    decoded.tunnel.worldPort = 25566
    const tampered = `${prefix}.${code}.${Buffer.from(JSON.stringify(decoded)).toString('base64url')}.${signature}`
    expect(() => parseTicket(tampered, { now: 1_800_000_100 })).toThrowError(
      expect.objectContaining({ code: 'TICKET_SIGNATURE_INVALID' }),
    )
  })

  it('rejects an expired ticket and a wrong short code', () => {
    const room = identity()
    const issued = issueTicket({
      identity: room,
      endpoints: [{ kind: 'lan', host: '10.1.2.3', port: 25999 }],
      tunnel,
      now: 1_800_000_000,
      ttlSeconds: 60,
    })
    expect(() => parseTicket(issued.ticket, { now: 1_800_100_000 })).toThrowError(
      expect.objectContaining({ code: 'INVITE_EXPIRED' }),
    )
    expect(() => parseTicket(issued.ticket, { now: 1_800_000_100, expectedCode: 'ZZZZZZ' })).toThrowError(
      expect.objectContaining({ code: 'INVITE_INVALID' }),
    )
  })

  it('rejects a malformed ticket without throwing unexpected errors', () => {
    expect(() => parseTicket('MCL-ABC123')).toThrowError(
      expect.objectContaining({ code: 'TICKET_MALFORMED' }),
    )
    expect(() => parseTicket('MCL1.ABC123.@@@.@@@')).toThrowError(
      expect.objectContaining({ code: 'TICKET_MALFORMED' }),
    )
  })
})
