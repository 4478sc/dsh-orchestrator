import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ACTIVATION_SHAPE,
  DELIVER_PROMPT,
  activationShape,
  flattenActivationSpec,
  nestActivationSpec,
  startContinuableCompat,
  startOneShotCompat,
} from '../lib/start-compat.js'

const signal = new AbortController().signal
const parent = { id: 'session-parent' }
const route = { provider: 'spawn-worker', model: 'local-deterministic' }

/** The spec `worker.js` has always built: the nested one DSH 0.2.1 reads. */
const nestedSpec = () => ({
  provider: 'spawn',
  label: 'probe',
  request: {
    prompt: [{ type: 'text', text: 'hello' }],
    parent,
    agentOptions: route,
    maxDepth: 1,
  },
  signal,
  delivery: 'parent',
})

/**
 * A 0.2.1-shaped host: it still carries the plugin-authored delivery entry, and its
 * `startActivation` reads `spec.request.parent.id` before anything else.
 */
function legacyHost() {
  const calls = []
  const subagents = {
    [DELIVER_PROMPT]: () => 'queued',
    async startActivation(spec) {
      calls.push(spec)
      if (spec.request.parent !== parent) throw new TypeError('legacy host read spec.request')
      return { childId: 'child-legacy', messageId: 'message-legacy' }
    },
  }
  return { subagents, calls }
}

/**
 * A 0.2.2-shaped host: the delivery entry is gone, and `startActivation` reads
 * `spec.parent.id` directly, so a nested request would throw before a child exists.
 */
function modernHost() {
  const calls = []
  const subagents = {
    prompt: async () => ({ messageId: 'queued' }),
    async startActivation(spec) {
      calls.push(spec)
      if (spec.parent?.id === undefined) throw new TypeError("Cannot read properties of undefined (reading 'id')")
      return { childId: 'child-modern', messageId: 'message-modern' }
    },
  }
  return { subagents, calls }
}

test('the shape follows the host generation markers, not a version string', () => {
  assert.equal(activationShape(legacyHost().subagents), ACTIVATION_SHAPE.nested)
  assert.equal(activationShape(modernHost().subagents), ACTIVATION_SHAPE.flat)
  // A host with neither marker keeps the spec 0.8.0 has always sent.
  assert.equal(activationShape({ startActivation: async () => ({}) }), ACTIVATION_SHAPE.nested)
  assert.equal(activationShape(null), ACTIVATION_SHAPE.nested)
  // A symbol that is not callable is not the delivery entry.
  assert.equal(
    activationShape({ [DELIVER_PROMPT]: true, prompt: async () => ({}) }),
    ACTIVATION_SHAPE.flat,
  )
})

test('DSH 0.2.1 receives the nested spec unchanged', async () => {
  const { subagents, calls } = legacyHost()
  const spec = nestedSpec()
  const started = await startContinuableCompat(subagents, spec)
  assert.equal(started.childId, 'child-legacy')
  assert.equal(calls.length, 1)
  assert.equal(calls[0], spec, 'the legacy spec must reach the host as the same object')
  assert.equal(calls[0].request.parent, parent)
})

test('DSH 0.2.2 receives the flat spec, with no request key left', async () => {
  const { subagents, calls } = modernHost()
  const spec = nestedSpec()
  const started = await startContinuableCompat(subagents, spec)
  assert.equal(started.childId, 'child-modern')
  assert.equal(calls.length, 1)
  const received = calls[0]
  assert.equal(Object.hasOwn(received, 'request'), false)
  assert.equal(received.provider, 'spawn')
  assert.equal(received.label, 'probe')
  assert.equal(received.delivery, 'parent')
  assert.equal(received.signal, signal)
  assert.equal(received.parent, parent)
  assert.deepEqual(received.agentOptions, route)
  assert.equal(received.maxDepth, 1)
  assert.deepEqual(received.prompt, [{ type: 'text', text: 'hello' }])
})

test('flattening lets the outer activation fields win and never mutates the producer spec', () => {
  const outerSignal = new AbortController().signal
  const spec = {
    provider: 'spawn',
    label: 'outer label',
    request: { prompt: [{ type: 'text', text: 'x' }], parent, label: 'inner label', delivery: 'parent' },
    signal: outerSignal,
    delivery: 'caller',
  }
  const flat = flattenActivationSpec(spec)
  assert.equal(flat.label, 'outer label')
  assert.equal(flat.delivery, 'caller')
  assert.equal(flat.signal, outerSignal)
  assert.equal(flat.prompt[0].text, 'x')
  assert.equal(spec.request.label, 'inner label', 'the input spec must stay untouched')
})

test('an already-flat spec passes through unchanged', async () => {
  const flat = { provider: 'spawn', label: 'flat', prompt: [], parent, signal, delivery: 'parent' }
  assert.equal(flattenActivationSpec(flat), flat)
  const { subagents, calls } = modernHost()
  await startContinuableCompat(subagents, flat)
  assert.equal(calls[0], flat)
})

test('a flat spec is rebuilt into the nested one a 0.2.1 host reads', async () => {
  const { subagents, calls } = legacyHost()
  const flat = {
    provider: 'spawn',
    label: 'flat',
    prompt: [{ type: 'text', text: 'x' }],
    parent,
    agentOptions: route,
    maxDepth: 2,
    signal,
    delivery: 'caller',
  }
  await startContinuableCompat(subagents, flat)
  const received = calls[0]
  assert.equal(received.provider, 'spawn')
  assert.equal(received.label, 'flat')
  assert.equal(received.delivery, 'caller')
  assert.equal(received.signal, signal)
  assert.equal(received.request.parent, parent)
  assert.equal(received.request.maxDepth, 2)
  assert.equal(Object.hasOwn(received.request, 'provider'), false)
  assert.equal(Object.hasOwn(received.request, 'label'), false)
  assert.equal(Object.hasOwn(received.request, 'delivery'), false)
  assert.equal(Object.hasOwn(received.request, 'signal'), false)
  assert.equal(nestActivationSpec(received), received, 'a nested spec is not re-nested')
})

test('a malformed spec fails loudly instead of reaching the host', () => {
  const { subagents, calls } = modernHost()
  assert.throws(() => startContinuableCompat(subagents, null), /activation spec must be an object/)
  assert.throws(
    () => startContinuableCompat(subagents, { provider: 'spawn', request: null }),
    /activation request must be an object/,
  )
  assert.throws(() => nestActivationSpec([]), /activation spec must be an object/)
  assert.equal(calls.length, 0)
})

test('a host without startActivation falls back to the legacy continuable entry', async () => {
  const calls = []
  const subagents = {
    async startContinuable(spec) {
      calls.push(spec)
      return { childId: 'child-2', messageId: 'message-2' }
    },
  }
  const spec = nestedSpec()
  assert.deepEqual(await startContinuableCompat(subagents, spec), {
    childId: 'child-2',
    messageId: 'message-2',
  })
  assert.equal(calls[0], spec)
})

test('a host without startActivation falls back to the one-shot entry and keeps label and signal', async () => {
  const calls = []
  const handle = { result: Promise.resolve({ output: 'OK' }), dispose: async () => {} }
  const subagents = {
    async start(provider, request) {
      calls.push({ provider, request })
      return handle
    },
  }
  assert.equal(await startOneShotCompat(subagents, nestedSpec()), handle)
  assert.equal(calls[0].provider, 'spawn')
  assert.equal(calls[0].request.label, 'probe')
  assert.equal(calls[0].request.signal, signal)
  assert.equal(calls[0].request.delivery, undefined, '0.2.0 does not know the delivery field')
  assert.deepEqual(calls[0].request.agentOptions, route)
})

test('a flat spec also works on the 0.2.0 one-shot entry', async () => {
  const calls = []
  const subagents = {
    async start(provider, request) {
      calls.push({ provider, request })
      return { result: Promise.resolve(undefined) }
    },
  }
  await startOneShotCompat(subagents, {
    provider: 'spawn',
    label: 'flat',
    prompt: [{ type: 'text', text: 'x' }],
    parent,
    agentOptions: route,
    signal,
    delivery: 'caller',
  })
  assert.equal(calls[0].request.parent, parent)
  assert.equal(calls[0].request.label, 'flat')
  assert.equal(calls[0].request.delivery, undefined)
})

test('a host with no start entry fails with a named error', () => {
  assert.throws(() => startContinuableCompat({}, nestedSpec()), /neither startActivation nor startContinuable/)
  assert.throws(() => startOneShotCompat({}, nestedSpec()), /neither startActivation nor start/)
})

test('a host rejection surfaces unchanged, with its own code', async () => {
  const failure = Object.assign(new Error('subagent creation requires the exact live parent agent'), {
    code: 'UNAUTHORIZED',
  })
  const subagents = { async startActivation() { throw failure } }
  await assert.rejects(startContinuableCompat(subagents, nestedSpec()), (error) => error === failure)
  await assert.rejects(startOneShotCompat(subagents, nestedSpec()), (error) => error.code === 'UNAUTHORIZED')
})

test('a pre-aborted signal reaches the host, which owns cancellation', async () => {
  const { subagents, calls } = modernHost()
  const controller = new AbortController()
  controller.abort()
  await startContinuableCompat(subagents, { ...nestedSpec(), signal: controller.signal })
  assert.equal(calls[0].signal.aborted, true)
})
