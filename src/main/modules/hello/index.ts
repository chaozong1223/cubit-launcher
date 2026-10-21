import type { ModuleContext } from '../_registry'

export const moduleId = 'hello'

/**
 * Demonstrates the self-registration contract. It intentionally does no work:
 * t6+ will add real modules next to it without touching the registry.
 */
export function register(ctx: ModuleContext): void {
  ctx.log.info('hello module registered', { moduleId })
}
