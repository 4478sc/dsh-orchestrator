import test from 'node:test'
import assert from 'node:assert/strict'
import { DELIVER_PROMPT, STEER_FALLBACK_PREFIX, deliverRetryPrompt } from '../lib/deliver-compat.js'

/**
 * A retry must be a new turn on the same durable child. These tests pin each channel the
 * two shipped hosts actually expose:
 *
 * - 0.2.1: `subagents[Symbol.for('dsh.subagent.deliverPrompt')](parent, childId, content,
 *   source, signal, 'queue')`, which needs the exact live parent Agent.
 * - 0.2.2: `subagents.prompt({ requestId, childSessionId, delivery, content }, signal)`,
 *   which mints `{ messageId }` and needs no resident parent.
 * - both: `subagents.sendMessage(sender, targetId, content, { signal })`, a steer that is
 *   only used when neither queueing channel exists.
 */

const parent = { id: 'parent-1' }

test('0.2.1: the plugin delivery entry queues the retry as a distinct turn', async () => {
  const calls = []
  const subagents = {
    [DELIVER_PROMPT]: (...args) => {
      calls.push(args)
      return 'message-legacy'
    },
  }
  const ctx = { agents: { get: (id) => (id === 'parent-1' ? parent : undefined) }, subagents }
  assert.equal(await deliverRetryPrompt(ctx, 'parent-1', 'child-1', '继续'), 'message-legacy')
  const [sender, childId, content, source, signal, delivery] = calls[0]
  assert.equal(sender, parent)
  assert.equal(childId, 'child-1')
  assert.deepEqual(content, [{ type: 'text', text: '继续' }])
  assert.deepEqual(source, { kind: 'orchestrator-retry', form: 'notice' })
  assert.equal(delivery, 'queue', 'a retry is a new turn, not a steer')
  assert.equal(typeof signal?.aborted, 'boolean')
})

test('0.2.1: a parent that is not live is refused before the host is called', async () => {
  let called = false
  const subagents = { [DELIVER_PROMPT]: () => { called = true } }
  await assert.rejects(
    deliverRetryPrompt({ agents: { get: () => undefined }, subagents }, 'parent-1', 'child-1', '继续'),
    /is not live/,
  )
  assert.equal(called, false)
})

test('0.2.2: the control face queues a new turn and returns its message id', async () => {
  const calls = []
  const subagents = {
    async prompt(request, signal) {
      calls.push({ request, signal })
      return { messageId: 'message-modern' }
    },
  }
  const ctx = { subagents }
  assert.equal(await deliverRetryPrompt(ctx, 'parent-1', 'child-1', '继续'), 'message-modern')
  const { request, signal } = calls[0]
  assert.equal(request.childSessionId, 'child-1')
  assert.equal(request.delivery, 'queue')
  assert.deepEqual(request.content, [{ type: 'text', text: '继续' }])
  assert.match(request.requestId, /^orchestrator-retry-/)
  // 0.2.2 dropped both fields from its control schema; sending them would describe a
  // different contract than the one the service validates.
  assert.equal(Object.hasOwn(request, 'parentSessionId'), false)
  assert.equal(Object.hasOwn(request, 'mode'), false)
  assert.equal(typeof signal?.aborted, 'boolean')
  // No live parent is needed on this path, which is why a cold child can still be woken.
  assert.equal(ctx.agents, undefined)
})

test('0.2.2: every call mints its own request id', async () => {
  const ids = []
  const subagents = {
    async prompt(request) {
      ids.push(request.requestId)
      return { messageId: 'id' }
    },
  }
  await deliverRetryPrompt({ subagents }, 'parent-1', 'child-1', 'a')
  await deliverRetryPrompt({ subagents }, 'parent-1', 'child-1', 'b')
  assert.notEqual(ids[0], ids[1])
})

test('the newest channel wins when a host exposes both', async () => {
  const order = []
  const subagents = {
    [DELIVER_PROMPT]: () => {
      order.push('legacy')
      return 'legacy'
    },
    async prompt() {
      order.push('prompt')
      return { messageId: 'prompt' }
    },
  }
  assert.equal(
    await deliverRetryPrompt({ agents: { get: () => parent }, subagents }, 'parent-1', 'child-1', 'x'),
    'legacy',
  )
  assert.deepEqual(order, ['legacy'], 'the host-specific entry keeps its exact behaviour')
})

test('the steer degradation is marked and still needs the exact live sender', async () => {
  const calls = []
  const subagents = {
    async sendMessage(sender, targetId, content, options) {
      calls.push({ sender, targetId, content, options })
      return 'inbox-1'
    },
  }
  assert.equal(
    await deliverRetryPrompt(
      { agents: { get: () => parent }, subagents },
      'parent-1',
      'child-1',
      '继续',
    ),
    'inbox-1',
  )
  assert.equal(calls[0].sender, parent)
  assert.equal(calls[0].targetId, 'child-1')
  assert.equal(calls[0].content[0].text.startsWith(STEER_FALLBACK_PREFIX), true)
  assert.equal(typeof calls[0].options.signal?.aborted, 'boolean')

  await assert.rejects(
    deliverRetryPrompt({ agents: { get: () => undefined }, subagents }, 'parent-1', 'child-1', '继续'),
    /subagents.sendMessage \(the only remaining channel\) cannot be used/,
  )
})

test('a host refusal keeps its channel name, code and cause', async () => {
  const failure = Object.assign(new Error('child session is not resumable'), { code: 'subagent/not-resumable' })
  const subagents = {
    async prompt() {
      throw failure
    },
  }
  await assert.rejects(deliverRetryPrompt({ subagents }, 'parent-1', 'child-1', 'x'), (error) => {
    assert.match(error.message, /subagents\.prompt refused the retry prompt \(subagent\/not-resumable\): child session is not resumable/)
    assert.equal(error.code, 'subagent/not-resumable')
    assert.equal(error.cause, failure)
    return true
  })
})

test('a host with no delivery channel fails with a message that names every channel', async () => {
  await assert.rejects(
    deliverRetryPrompt({ agents: { get: () => parent }, subagents: {} }, 'parent-1', 'child-1', 'x'),
    /neither dsh\.subagent\.deliverPrompt nor subagents\.prompt, and subagents\.sendMessage is unavailable/,
  )
  await assert.rejects(deliverRetryPrompt({}, 'parent-1', 'child-1', 'x'), /neither dsh\.subagent\.deliverPrompt/)
})

test('the source kind defaults to the retry kind and stays overridable', async () => {
  const sources = []
  const subagents = {
    [DELIVER_PROMPT]: (...args) => {
      sources.push(args[3])
      return 'id'
    },
  }
  const ctx = { agents: { get: () => parent }, subagents }
  await deliverRetryPrompt(ctx, 'parent-1', 'child-1', 'x')
  await deliverRetryPrompt(ctx, 'parent-1', 'child-1', 'x', { sourceKind: 'orchestrator-probe' })
  assert.equal(sources[0].kind, 'orchestrator-retry')
  assert.equal(sources[1].kind, 'orchestrator-probe')
})

test('a non-object receipt is returned as the host produced it', async () => {
  const subagents = {
    async prompt() {
      return 'plain-id'
    },
  }
  assert.equal(await deliverRetryPrompt({ subagents }, 'parent-1', 'child-1', 'x'), 'plain-id')
})
