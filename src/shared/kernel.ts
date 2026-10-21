import type { ZodType } from 'zod'

/** The only successful/failed IPC shape; errors never throw across the bridge. */
export type Result<T> = { ok: true; data: T } | { ok: false; error: AppErrorShape }

export interface AppErrorShape {
  code: string
  message: string
  retryable: boolean
  details?: Record<string, unknown>
}

export const CONTRACT_BRAND = Symbol.for('mc.contract')

export interface MethodDef {
  input: ZodType
  output: ZodType
}

export interface EventDef {
  payload: ZodType
  throttleMs?: number
}

export interface ContractShape {
  id: string
  methods: Record<string, MethodDef>
  events: Record<string, EventDef>
}

export type ContractDef<C extends ContractShape = ContractShape> = C & Record<symbol, unknown>

/**
 * Marks an object as an IPC contract. The brand is intentionally a global
 * symbol so preload/renderer can discover contracts without filename rules.
 */
export function defineContract<C extends ContractShape>(def: C): ContractDef<C> {
  return Object.freeze({ ...def, [CONTRACT_BRAND]: true as const })
}

export function isContract(value: unknown): value is ContractDef {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<symbol, unknown>)[CONTRACT_BRAND] === true
  )
}

export function channelOf(moduleId: string, method: string): string {
  return `mc:${moduleId}:${method}`
}

export function eventChannelOf(moduleId: string, event: string): string {
  return `mc:${moduleId}:evt:${event}`
}
