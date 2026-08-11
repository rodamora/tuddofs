import assert from 'node:assert/strict'
import test from 'node:test'

import { CaptureSlot } from '../sync/slot.js'

type Deferred = { promise: Promise<void>; resolve: () => void }

function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>(resolveFn => {
    resolve = resolveFn
  })
  return { promise, resolve }
}

test('a trigger starts the capture immediately and extra triggers coalesce to one follow-up', async () => {
  const gate = deferred()
  let started = 0
  const slot = new CaptureSlot(
    () => {
      started += 1
      return started === 1 ? gate.promise : Promise.resolve()
    },
    () => assert.fail('capture must not fail'),
  )

  slot.trigger()
  assert.equal(started, 1)
  slot.trigger()
  slot.trigger()
  slot.trigger()
  assert.equal(started, 1)

  gate.resolve()
  await slot.settle()
  assert.equal(started, 2)
})

test('a failed capture releases the slot, reports the attempt, and never wedges', async () => {
  const failures: { attempt: number; message: string }[] = []
  let runs = 0
  const slot = new CaptureSlot(
    () => {
      runs += 1
      return runs <= 2 ? Promise.reject(new Error(`scan ${runs}`)) : Promise.resolve()
    },
    (attempt, error) => failures.push({ attempt, message: error.message }),
  )

  slot.trigger()
  await slot.settle()
  slot.trigger()
  await slot.settle()
  assert.deepEqual(failures, [
    { attempt: 1, message: 'scan 1' },
    { attempt: 2, message: 'scan 2' },
  ])
  assert.equal(slot.consecutiveFailures, 2)

  slot.trigger()
  await slot.settle()
  assert.equal(runs, 3)
  assert.equal(slot.consecutiveFailures, 0)
  assert.equal(failures.length, 2)
})

test('a non-Error rejection still reaches the failure callback as an Error', async () => {
  const failures: Error[] = []
  const slot = new CaptureSlot(
    async () => {
      // A dying sandbox rejects with whatever it has; the slot must normalize it.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'target vanished'
    },
    (_attempt, error) => failures.push(error),
  )

  slot.trigger()
  await slot.settle()
  assert.equal(failures.length, 1)
  assert.ok(failures[0] instanceof Error)
  assert.match(String(failures[0]?.message), /target vanished/u)
})

test('exclusive work never overlaps a capture and propagates its own errors', async () => {
  const running: string[] = []
  const gate = deferred()
  const slot = new CaptureSlot(async () => {
    running.push('capture:start')
    await gate.promise
    running.push('capture:end')
  })

  slot.trigger()
  const exclusive = slot.exclusive(async () => {
    running.push('reconcile')
    return 'done'
  })
  assert.deepEqual(running, ['capture:start'])

  gate.resolve()
  assert.equal(await exclusive, 'done')
  assert.deepEqual(running, ['capture:start', 'capture:end', 'reconcile'])

  await assert.rejects(
    slot.exclusive(() => Promise.reject(new Error('reconcile failed'))),
    /reconcile failed/u,
  )
  await slot.settle()
})

test('triggers raised during exclusive work run after it, one at a time', async () => {
  const order: string[] = []
  const slot = new CaptureSlot(() => {
    order.push('capture')
    return Promise.resolve()
  })

  await slot.exclusive(async () => {
    order.push('reconcile')
    slot.trigger()
    slot.trigger()
    order.push('reconcile:end')
  })
  await slot.settle()

  assert.deepEqual(order, ['reconcile', 'reconcile:end', 'capture'])
})

test('settle waits for work queued while it is already waiting', async () => {
  const gate = deferred()
  let runs = 0
  const slot = new CaptureSlot(async () => {
    runs += 1
    if (runs === 1) await gate.promise
  })

  slot.trigger()
  const settled = slot.settle()
  slot.trigger()
  gate.resolve()
  await settled

  assert.equal(runs, 2)
})
