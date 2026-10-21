import type { AuthService } from './service'

/** Contract methods → service. The kernel validates inputs/outputs and wraps
 * every result in the Result envelope. */
export function makeHandlers(service: AuthService) {
  return {
    list: () => service.list(),
    createOffline: (input: { name: string }) => service.createOffline(input.name),
    createAuthlib: (input: { name: string; server: string }) =>
      service.createAuthlib(input.name, input.server),
    select: (input: { id: string }) => service.select(input.id),
    beginDeviceCode: () => service.beginDeviceCode(),
    pollDeviceCode: (input: { flowId: string }) => service.pollDeviceCode(input.flowId),
    logout: (input: { id: string }) => service.logout(input.id),
    setAuthlib: (input: { id: string; server: string }) =>
      service.setAuthlib(input.id, input.server),
    configureMicrosoft: (input: { clientId?: string | null; tenant?: string }) =>
      service.configureMicrosoft(input),
    getMicrosoftConfig: () => service.getMicrosoftConfig(),
    authlibInfo: () => service.authlibInfo(),
    ensureAuthlib: () => service.ensureAuthlib(),
  }
}

export type AuthHandlers = ReturnType<typeof makeHandlers>
