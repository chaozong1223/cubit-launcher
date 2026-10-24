import type {
  CopyInviteOutput,
  CreateRoomInput,
  DiagnoseOutput,
  EnterWorldInput,
  JoinLanWorldInput,
  JoinRoomInput,
  LanWorldsInput,
  LanWorldsOutput,
  NetSettings,
  NetSettingsUpdate,
  PublicIpProbe,
  RoomInfo,
  SetWorldPortInput,
  TestRelayInput,
  TestRelayOutput,
} from '@shared/net'
import type { RoomService } from './room'

/**
 * Thin handlers object. t10 extends the frozen IPC/preload whitelist and calls
 * these through the service registry; this task deliberately does not edit
 * src/main/kernel/ipc.ts or src/preload (both are in arch/frozen.manifest.json).
 */
export function makeHandlers(service: RoomService) {
  return {
    create: (input: CreateRoomInput): Promise<RoomInfo> => service.create(input),
    join: (input: JoinRoomInput): Promise<RoomInfo> => service.join(input),
    leave: (): Promise<{ ok: boolean }> => service.leave(),
    status: (): RoomInfo | null => service.status(),
    copyInvite: (): Promise<CopyInviteOutput> => service.copyInvite(),
    setWorldPort: (input: SetWorldPortInput): Promise<RoomInfo> => service.setWorldPort(input),
    enterWorld: (input: EnterWorldInput): Promise<{
      sessionId: string
      server: { host: string; port: number }
    }> => service.enterWorld(input),
    lanWorlds: (input: LanWorldsInput): Promise<LanWorldsOutput> => service.lanWorlds(input),
    joinLanWorld: (input: JoinLanWorldInput): Promise<{
      sessionId: string
      server: { host: string; port: number }
    }> => service.joinLanWorld(input),
    diagnose: (): Promise<DiagnoseOutput> => service.diagnose(),
    settings: (): NetSettings => service.settings(),
    updateSettings: (input: NetSettingsUpdate): Promise<NetSettings> => service.updateSettings(input),
    probePublicIp: (): Promise<PublicIpProbe> => service.probePublicIp(),
    testRelay: (input: TestRelayInput): Promise<TestRelayOutput> => service.testRelay(input),
  }
}

export type NetHandlers = ReturnType<typeof makeHandlers>
