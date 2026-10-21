import type { AuthService } from './service'

/** Contract methods → service. The kernel validates inputs/outputs and wraps
 * every result in the Result envelope. */
export function makeHandlers(service: AuthService) {
  return {
    list: () => service.list(),
    createOffline: (input: { name: string }) => service.createOffline(input.name),
    createAuthlib: (input: { name: string; server: string; password?: string }) =>
      service.createAuthlib(input.name, input.server, input.password),
    loginAuthlib: (input: { name: string; password: string; server: string }) =>
      service.loginAuthlib(input.name, input.password, input.server),
    validateAuthlibSession: (input: { id: string }) =>
      service.validateAuthlibSession(input.id),
    signoutAuthlib: (input: { id: string }) => service.signoutAuthlib(input.id),
    profile: (input: { id: string }) => service.profile(input.id),
    sessionStatus: (input: { id: string }) => service.sessionStatus(input.id),
    refresh: (input: { id: string }) => service.refresh(input.id),
    reauth: (input: { id: string }) => service.reauth(input.id),
    authlibPresets: () => ({ presets: service.authlibPresets() }),
    validateAuthlib: (input: { server: string }) => service.validateAuthlib(input.server),
    select: (input: { id: string }) => service.select(input.id),
    beginDeviceCode: () => service.beginDeviceCode(),
    beginAuthCode: () => service.beginAuthCode(),
    pollAuthCode: (input: { flowId: string }) => service.pollAuthCode(input.flowId),
    cancelAuthCode: (input: { flowId: string }) => service.cancelAuthCode(input.flowId),
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
