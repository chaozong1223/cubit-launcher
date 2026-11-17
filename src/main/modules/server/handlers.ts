import type {
  ServerCommandInput,
  ServerCreateInput,
  ServerIdInput,
  ServerInfo,
  ServerLogInput,
  ServerVersion,
} from '@shared/server'
import type { ServerService } from './service'

export function makeHandlers(service: ServerService) {
  return {
    list: (): ServerInfo[] => service.list(),
    versions: (): ServerVersion[] => service.versions(),
    create: (input: ServerCreateInput): Promise<ServerInfo> => service.create(input),
    start: (input: ServerIdInput): Promise<ServerInfo> => service.start(input.id),
    stop: (input: ServerIdInput): Promise<ServerInfo> => service.stop(input.id),
    remove: (input: ServerIdInput): Promise<{ ok: boolean }> => service.remove(input.id),
    status: (input: ServerIdInput): ServerInfo | null => service.status(input.id),
    logs: (input: ServerLogInput): { lines: string[] } => ({
      lines: service.logs(input.id, input.lines),
    }),
    command: (input: ServerCommandInput): { ok: boolean } =>
      service.command(input.id, input.command),
  }
}
