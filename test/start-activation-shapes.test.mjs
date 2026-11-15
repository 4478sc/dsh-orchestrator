import test from 'node:test'
import assert from 'node:assert/strict'
import { DELIVER_PROMPT, startContinuableCompat, startOneShotCompat } from '../lib/start-compat.js'
import { buildSpawnActivation } from '../lib/worker.js'

/**
 * These tests drive the *production* spec producer through both host generations:
 *
 * - DSH 0.2.1 reads `spec.request.parent.id` / `spec.request.maxDepth` /
 *   `spec.request.outputSchema` plus `spec.provider`, `spec.signal`, `spec.delivery`.
 * - DSH 0.2.2 reads the same values flat: `spec.parent.id`, `spec.maxDepth`,
 *   `spec.outputSchema`, `spec.signal`, `spec.delivery`.
 *
 * Both fakes read the field their real service reads first, so a wrong shape fails here
 * the same way it fails on the host.
 */

const signal = new AbortController().signal
const parent = { id: 'session-parent', session: { id: 'session-parent' } }
const route = { provider: 'spawn-worker', model: 'local-deterministic' }

const delegateSpec = () =>
  buildSpawnActivation({
    cwd: '/tmp/worker',
    prompt: 'do the thing',
    label: 'delegate probe',
    parent,
    route,
    maxDepth: 1,
    signal,
    delivery: 'parent',
  })

const orchestrateSpec = () =>
  buildSpawnActivation({
    cwd: '/tmp/worker',
    prompt: 'do the thing',
    label: 'orchestrate probe',
    parent,
    route,
    maxDepth: 2,
    signal,
    outputSchema: { type: 'object', properties: {}, additionalProperties: false },
    delivery: 'caller',
  })

/** 0.2.1 fake: reads the nested request first, like the shipped service does. */
function legacyHost() {
  const calls = []
  const subagents = {
    [DELIVER_PROMPT]: () => 'queued',
    async startActivation(spec) {
      calls.push(spec)
      if (spec.request.maxDepth === undefined) throw new TypeError('legacy host read spec.request.maxDepth')
      if (spec.request.parent.id !== 'session-parent') throw new Error('legacy host read spec.request.parent.id')
      return {
        childId: 'child-legacy',
        messageId: 'message-legacy',
        result: Promise.resolve({ output: [{ type: 'text', text: 'OK' }], stopReason: 'completed' }),
        dispose: async () => {},
      }
    },
  }
  return { subagents, calls }
}

/** 0.2.2 fake: reads the flat spec first, like the shipped service does. */
function modernHost() {
  const calls = []
  const subagents = {
    prompt: async () => ({ messageId: 'queued' }),
    async startActivation(spec) {
      calls.push(spec)
      if (spec.parent?.id === undefined) throw new TypeError("Cannot read properties of undefined (reading 'id')")
      return {
        childId: 'child-modern',
        messageId: 'message-modern',
        result: Promise.resolve({ output: [{ type: 'text', text: 'OK' }], stopReason: 'completed' }),
        dispose: async () => {},
      }
    },
  }
  return { subagents, calls }
}

test('the delegate spec reaches a 0.2.1 host nested and intact', async () => {
  const { subagents, calls } = legacyHost()
  const spec = delegateSpec()
  const started = await startContinuableCompat(subagents, spec)
  assert.equal(started.childId, 'child-legacy')
  const received = calls[0]
  assert.equal(received.request.parent, parent)
  assert.equal(received.request.cwd, '/tmp/worker')
  assert.equal(received.request.maxDepth, 1)
  assert.deepEqual(received.request.agentOptions, route)
  assert.deepEqual(received.request.prompt, [{ type: 'text', text: 'do the thing' }])
  assert.equal(received.provider, 'spawn')
  assert.equal(received.label, 'delegate probe')
  assert.equal(received.delivery, 'parent')
  assert.equal(received.signal, signal)
})

test('the delegate spec reaches a 0.2.2 host flat and intact', async () => {
  const { subagents, calls } = modernHost()
  await startContinuableCompat(subagents, delegateSpec())
  const received = calls[0]
  assert.equal(Object.hasOwn(received, 'request'), false)
  assert.equal(received.parent, parent)
  assert.equal(received.parent.id, 'session-parent')
  assert.equal(received.cwd, '/tmp/worker')
  assert.equal(received.maxDepth, 1)
  assert.deepEqual(received.agentOptions, route)
  assert.deepEqual(received.prompt, [{ type: 'text', text: 'do the thing' }])
  assert.equal(received.provider, 'spawn')
  assert.equal(received.label, 'delegate probe')
  assert.equal(received.delivery, 'parent')
  assert.equal(received.signal, signal)
})

test('the orchestrate spec keeps delivery=caller, outputSchema and maxDepth on both hosts', async () => {
  const schema = { type: 'object', properties: {}, additionalProperties: false }
  const legacy = legacyHost()
  await startOneShotCompat(legacy.subagents, orchestrateSpec())
  const nested = legacy.calls[0]
  assert.deepEqual(nested.request.outputSchema, schema)
  assert.equal(nested.request.maxDepth, 2)
  assert.equal(nested.delivery, 'caller')

  const modern = modernHost()
  await startOneShotCompat(modern.subagents, orchestrateSpec())
  const flat = modern.calls[0]
  assert.deepEqual(flat.outputSchema, schema)
  assert.equal(flat.maxDepth, 2)
  assert.equal(flat.delivery, 'caller')
  assert.equal(flat.parent.id, 'session-parent')
  assert.equal(Object.hasOwn(flat, 'request'), false)
})

test('the returned handle keeps its receipt.result and dispose untouched', async () => {
  for (const { subagents } of [legacyHost(), modernHost()]) {
    const returned = await startOneShotCompat(subagents, orchestrateSpec())
    assert.equal(typeof returned.dispose, 'function')
    assert.deepEqual(await returned.result, {
      output: [{ type: 'text', text: 'OK' }],
      stopReason: 'completed',
    })
  }
})

test('a host failure propagates unchanged on both generations', async () => {
  for (const subagents of [
    { [DELIVER_PROMPT]: () => 'queued', async startActivation() { throw new Error('activation limit reached') } },
    { prompt: async () => ({}), async startActivation() { throw new Error('activation limit reached') } },
  ]) {
    await assert.rejects(startContinuableCompat(subagents, delegateSpec()), /activation limit reached/)
    await assert.rejects(startOneShotCompat(subagents, orchestrateSpec()), /activation limit reached/)
  }
})

test('a spec built for neither host shape still normalises to what that host reads', async () => {
  const flat = {
    provider: 'spawn',
    label: 'flat',
    prompt: [{ type: 'text', text: 'x' }],
    parent,
    agentOptions: route,
    maxDepth: 1,
    signal,
    delivery: 'parent',
  }
  const legacy = legacyHost()
  await startContinuableCompat(legacy.subagents, flat)
  assert.equal(legacy.calls[0].request.parent, parent)

  const modern = modernHost()
  await startContinuableCompat(modern.subagents, flat)
  assert.equal(modern.calls[0], flat)
})
