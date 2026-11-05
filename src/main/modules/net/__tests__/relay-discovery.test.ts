import { beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_RELAY_PEERS,
  STATIC_RELAY_PEERS,
  discoverRelayPeers,
  mergeRelayPeers,
  parseRelayNodeResponse,
  resetRelayDiscoveryCache,
} from '../relay-discovery'

describe('parseRelayNodeResponse', () => {
  it('accepts the tcp:// line the endpoints actually return', () => {
    expect(parseRelayNodeResponse('tcp://183.66.27.22:39409\n')).toBe(
      'tcp://183.66.27.22:39409',
    )
  })

  it('keeps hostname peers without a port', () => {
    expect(parseRelayNodeResponse('tcp://node.example.org')).toBe('tcp://node.example.org')
  })

  it('rejects the empty body node2 currently returns', () => {
    expect(parseRelayNodeResponse('')).toBeNull()
    expect(parseRelayNodeResponse('   \n')).toBeNull()
  })

  it('rejects garbage instead of feeding EasyTier a bad peer', () => {
    expect(parseRelayNodeResponse('<html>404</html>')).toBeNull()
    expect(parseRelayNodeResponse('tcp://host:99999')).toBeNull()
    expect(parseRelayNodeResponse('http://example.com/path')).toBeNull()
  })
})

describe('mergeRelayPeers', () => {
  it('deduplicates while keeping discovery first', () => {
    expect(
      mergeRelayPeers(['tcp://a:1'], ['tcp://a:1', 'tcp://b:2']),
    ).toEqual(['tcp://a:1', 'tcp://b:2'])
  })

  it('caps the list so a launch does not dial a dozen peers', () => {
    const many = Array.from({ length: 10 }, (_, i) => `tcp://h${i}:1${i}`)
    expect(mergeRelayPeers(many)).toHaveLength(MAX_RELAY_PEERS)
  })
})

describe('discoverRelayPeers', () => {
  beforeEach(() => {
    resetRelayDiscoveryCache()
  })

  it('uses the discovered node and ignores a dead endpoint', async () => {
    const peers = await discoverRelayPeers(['tcp://user:1234'], {
      fetchText: async (url) =>
        url.endsWith('/node1') ? 'tcp://183.66.27.22:39409' : '',
    })
    expect(peers[0]).toBe('tcp://183.66.27.22:39409')
    expect(peers).toContain('tcp://user:1234')
  })

  it('falls back to the static peers when everything is down', async () => {
    const peers = await discoverRelayPeers([], {
      fetchText: async () => null,
    })
    expect(peers).toEqual([...STATIC_RELAY_PEERS])
  })

  it('caches the result and does not re-fetch within the TTL', async () => {
    let calls = 0
    const fetchText = async (): Promise<string> => {
      calls += 1
      return 'tcp://183.66.27.22:39409'
    }
    await discoverRelayPeers([], { fetchText })
    await discoverRelayPeers([], { fetchText })
    expect(calls).toBe(2) // one call per endpoint, then cached
  })

  it('never throws when the fetch itself rejects', async () => {
    const peers = await discoverRelayPeers([], {
      fetchText: async () => {
        throw new Error('boom')
      },
    })
    expect(peers).toEqual([...STATIC_RELAY_PEERS])
  })
})
