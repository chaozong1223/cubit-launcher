/**
 * Small network helpers shared by the room controller.
 */

/** RFC 1918 / CGNAT / loopback / link-local ranges that cannot be dialled. */
export function isPublicIpv4(ip: string): boolean {
  const parts = ip.split('.').map((value) => Number(value))
  if (parts.length !== 4 || parts.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    return false
  }
  const [a, b] = parts
  if (a === 0 || a === 127) return false
  if (a === 10) return false
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 168) return false
  if (a === 169 && b === 254) return false
  // 100.64.0.0/10 — carrier-grade NAT, shared by many subscribers.
  if (a === 100 && b >= 64 && b <= 127) return false
  if (a >= 224) return false
  return true
}
