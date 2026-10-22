/**
 * Reusable undo log for multi-step filesystem imports.
 *
 * Every mutating step registers an inverse action; if a later step fails the
 * caller runs `rollback()` and the stack unwinds in reverse order, attempting
 * every action even when one of them fails. `commit()` discards the log once
 * the operation succeeded. Instance share-pack import and cross-version save
 * copies share this so a half-applied import can always be restored.
 */

export interface RollbackAction {
  /** Short human-readable description used in logs/errors. */
  label: string
  undo: () => void | Promise<void>
}

export interface RollbackFailure {
  label: string
  message: string
}

export class RollbackStack {
  private readonly actions: RollbackAction[] = []

  get size(): number {
    return this.actions.length
  }

  labels(): string[] {
    return this.actions.map((action) => action.label)
  }

  push(label: string, undo: () => void | Promise<void>): void {
    this.actions.push({ label, undo })
  }

  /** Drop the undo log after a successful commit. */
  commit(): void {
    this.actions.length = 0
  }

  /** Unwind in reverse order; never throws, reports per-step failures. */
  async rollback(): Promise<RollbackFailure[]> {
    const failures: RollbackFailure[] = []
    while (this.actions.length > 0) {
      const action = this.actions.pop()
      if (!action) break
      try {
        await action.undo()
      } catch (error) {
        failures.push({
          label: action.label,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return failures
  }
}
