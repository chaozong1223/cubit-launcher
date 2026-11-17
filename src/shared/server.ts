import { z } from 'zod'
import { defineContract } from './kernel'

/**
 * Local Minecraft servers (原版开服).
 *
 * MVP scope: only versions whose version JSON carries `downloads.server`
 * (vanilla, and any loader that ships a ready server jar). Forge/Fabric need an
 * installer, so `create` refuses them with a readable error instead of
 * pretending.
 *
 * The EULA is never accepted implicitly: `acceptEula` must be literally `true`,
 * which the UI only sends after the user ticks the checkbox.
 */
export const ServerState = z.enum(['stopped', 'starting', 'running', 'stopping', 'crashed'])
export type ServerState = z.infer<typeof ServerState>

export const ServerInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  versionId: z.string(),
  mcVersion: z.string().nullable(),
  port: z.number().int(),
  memoryMb: z.number().int(),
  onlineMode: z.boolean(),
  state: ServerState,
  pid: z.number().int().nullable(),
  /** Absolute directory that holds server.jar / eula.txt / server.properties. */
  dir: z.string(),
  createdAt: z.number().int(),
})
export type ServerInfo = z.infer<typeof ServerInfoSchema>

export const ServerCreateInputSchema = z.object({
  name: z.string().min(1).max(48),
  versionId: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(25565),
  memoryMb: z.number().int().min(512).max(65536).default(2048),
  onlineMode: z.boolean().default(true),
  acceptEula: z.literal(true),
  /**
   * Version directory whose `mods/` is copied into the new server, so a loader
   * server starts with the same mod set as the client instance. null = none.
   */
  copyModsFrom: z.string().max(128).nullable().default(null),
})
export type ServerCreateInput = z.infer<typeof ServerCreateInputSchema>

export const ServerIdInputSchema = z.object({ id: z.string().min(1) })
export type ServerIdInput = z.infer<typeof ServerIdInputSchema>

export const ServerLogInputSchema = z.object({
  id: z.string().min(1),
  lines: z.number().int().min(1).max(2000).default(200),
})
export type ServerLogInput = z.infer<typeof ServerLogInputSchema>

export const ServerCommandInputSchema = z.object({
  id: z.string().min(1),
  command: z.string().min(1).max(512),
})
export type ServerCommandInput = z.infer<typeof ServerCommandInputSchema>

/** A version that can be turned into a server (vanilla jar or loader installer). */
export const ServerLoader = z.enum(['vanilla', 'forge', 'neoforge', 'fabric', 'quilt'])
export type ServerLoader = z.infer<typeof ServerLoader>

export const ServerVersionSchema = z.object({
  id: z.string(),
  mcVersion: z.string().nullable(),
  loader: ServerLoader,
  /** Loader version (e.g. 14.23.5.2864); null for vanilla. */
  loaderVersion: z.string().nullable(),
})
export type ServerVersion = z.infer<typeof ServerVersionSchema>

export const serverContract = defineContract({
  id: 'server',
  methods: {
    list: { input: z.void(), output: z.array(ServerInfoSchema) },
    /** Versions whose JSON carries downloads.server (what we can one-click). */
    versions: { input: z.void(), output: z.array(ServerVersionSchema) },
    create: { input: ServerCreateInputSchema, output: ServerInfoSchema },
    start: { input: ServerIdInputSchema, output: ServerInfoSchema },
    stop: { input: ServerIdInputSchema, output: ServerInfoSchema },
    remove: { input: ServerIdInputSchema, output: z.object({ ok: z.boolean() }) },
    status: { input: ServerIdInputSchema, output: ServerInfoSchema.nullable() },
    logs: { input: ServerLogInputSchema, output: z.object({ lines: z.array(z.string()) }) },
    command: { input: ServerCommandInputSchema, output: z.object({ ok: z.boolean() }) },
    /** Zips mods/config into dataRoot/exports for friends to import. */
    exportClientPack: {
      input: ServerIdInputSchema,
      output: z.object({ path: z.string(), files: z.number().int().nonnegative() }),
    },
  },
  events: {
    /** Emitted whenever a server's state or log tail changes. */
    changed: {
      payload: z.object({
        id: z.string(),
        state: ServerState,
        pid: z.number().int().nullable(),
      }),
    },
  },
})

export type ServerContract = typeof serverContract
