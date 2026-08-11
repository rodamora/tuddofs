/**
 * The one-in-flight capture slot required by architecture §7.3 phase 3.
 *
 * Invariants:
 * - Exactly one capture runs per target at a time; triggers raised while one is
 *   running coalesce to exactly one follow-up, never a queue.
 * - The slot is RELEASED on failure as well as success, so N consecutive
 *   failures never wedge it (§7.5).
 * - A trigger starts its capture synchronously, so the scan overlaps the agent's
 *   next step instead of waiting for a microtask turn.
 * - Turn-end reconcile (§7.3 phase 4) is authoritative and runs through
 *   {@link CaptureSlot.exclusive}: it never overlaps a capture, and its errors
 *   propagate to its awaiting caller instead of the failure callback.
 */
export class CaptureSlot {
  readonly #capture: () => Promise<void>
  readonly #onFailure: ((attempt: number, error: Error) => void) | undefined
  #chain: Promise<void> = Promise.resolve()
  #busy = false
  #pending = false
  #failures = 0

  constructor(capture: () => Promise<void>, onFailure?: (attempt: number, error: Error) => void) {
    this.#capture = capture
    this.#onFailure = onFailure
  }

  /** Consecutive capture failures; reset by the first success. */
  get consecutiveFailures(): number {
    return this.#failures
  }

  /** Fire-and-forget Phase-3 trigger. Safe to call after every shell-capable step. */
  trigger(): void {
    if (this.#busy) {
      this.#pending = true
      return
    }
    this.#busy = true
    this.#chain = this.#drain()
  }

  /** Run authoritative work with the slot held; captures queue behind it. */
  async exclusive<T>(work: () => Promise<T>): Promise<T> {
    while (this.#busy) await this.#chain
    this.#busy = true
    let finished!: () => void
    this.#chain = new Promise<void>(resolve => {
      finished = resolve
    })
    try {
      return await work()
    } finally {
      this.#release()
      finished()
    }
  }

  /** Await every capture and exclusive job, including work queued while waiting. */
  async settle(): Promise<void> {
    let awaited: Promise<void> | undefined
    while (awaited !== this.#chain || this.#busy) {
      awaited = this.#chain
      await awaited
    }
  }

  async #drain(): Promise<void> {
    try {
      for (;;) {
        this.#pending = false
        try {
          await this.#capture()
          this.#failures = 0
        } catch (error) {
          this.#failures += 1
          this.#onFailure?.(this.#failures, error instanceof Error ? error : new Error(String(error)))
        }
        if (!this.#pending) return
      }
    } finally {
      this.#busy = false
    }
  }

  #release(): void {
    this.#busy = false
    if (!this.#pending) return
    this.#busy = true
    this.#chain = this.#drain()
  }
}
