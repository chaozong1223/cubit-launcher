/**
 * Stand-in for `ModuleContext.services` (docs/03 §4.4).
 *
 * The frozen t5 registry calls `register(ctx)` but discards the return value and
 * the context has no `services` locator yet. Publishing here lets later modules
 * (auth → launch, UI IPC → modules) find a service without importing another
 * module's implementation, which is the one rule the architecture cares about.
 */
const services = new Map<string, unknown>()

export function publishService<T>(id: string, service: T): void {
  services.set(id, service)
}

export function getService<T>(id: string): T | null {
  const service = services.get(id)
  return (service as T | undefined) ?? null
}

export function hasService(id: string): boolean {
  return services.has(id)
}

export function listServiceIds(): string[] {
  return [...services.keys()].sort()
}
