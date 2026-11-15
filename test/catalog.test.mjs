import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CATALOG_KEY,
  catalogOf,
  collectCatalog,
  createCatalogPublisher,
  isVolatileRef,
  rootAgents,
  viewNames,
} from '../lib/catalog.js'

/** The shared protocol a schemastery `.volatile()` field implements (cosmokit). */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/** A stand-in for a live volatile config reference. */
function volatileRef(value) {
  let current = value
  return {
    get: () => current,
    [VOLATILE_WRITE]: (next) => {
      current = next
    },
  }
}

/** A registry view shaped like `ctx.tools.view()`: hidden names plus the visible map. */
function view(known, visible) {
  return { knownNames: new Set(known), visible: new Map((visible ?? known).map((name) => [name, { name }])) }
}

test('a view contributes the names it knows, hidden ones included, and its own visible ones', () => {
  const names = viewNames(view(['read', 'edit'], ['edit', 'subagent']))
  // `knownNames` keeps a name a restriction hid, so a denied tool can still be unchecked.
  assert.deepEqual(names.sort(), ['edit', 'read', 'subagent'])
  assert.deepEqual(viewNames(undefined), [])
  assert.deepEqual(viewNames(null), [])
  assert.deepEqual(viewNames({}), [])
})

test('the catalog merges every view into one sorted, de-duplicated list', () => {
  const merged = catalogOf([
    view(['read', 'edit']),
    view(['edit', 'mcp__github__ping'], ['edit', 'mcp__github__ping', 'subagent']),
    view(['read', '', 7]),
  ])
  assert.deepEqual(merged, ['edit', 'mcp__github__ping', 'read', 'subagent'])
  assert.deepEqual(catalogOf([]), [])
  assert.deepEqual(catalogOf(undefined), [])
})

test('collectCatalog unions the global view with every live root agent scope', () => {
  const seen = []
  const rootA = { id: 'a', ctx: { tools: { view: (scope) => { seen.push(scope); return view(['subagent'], ['subagent']) } } } }
  const rootB = { id: 'b', ctx: { tools: { view: () => view(['ask_user_question'], ['ask_user_question']) } } }
  const ctx = {
    tools: { view: () => view(['read', 'edit'], ['read', 'edit']) },
    agents: { roots: () => [rootA, rootB] },
  }
  assert.deepEqual(collectCatalog(ctx), ['ask_user_question', 'edit', 'read', 'subagent'])
  // The scope is the agent itself, which is what the registry's per-scope view expects.
  assert.deepEqual(seen, [rootA])
})

test('collectCatalog survives a missing or throwing registry, scope or root list', () => {
  assert.deepEqual(collectCatalog(undefined), [])
  assert.deepEqual(collectCatalog({}), [])
  const throwing = {
    tools: { view: () => { throw new Error('no view') } },
    agents: { roots: () => { throw new Error('no roots') } },
  }
  assert.deepEqual(collectCatalog(throwing), [])
  const brokenRoot = {
    tools: { view: () => view(['read']) },
    agents: { roots: () => [{ id: 'broken', ctx: { tools: { view: () => { throw new Error('gone') } } } }] },
  }
  assert.deepEqual(collectCatalog(brokenRoot), ['read'])
})

/** One live-agent entry shaped like the 0.2.2 AgentRegistry.list() array. */
function liveAgent({ id = 'root', depth, header = {}, names = ['subagent'] } = {}) {
  return {
    id,
    options: depth === undefined ? {} : { subagentDepth: depth },
    session: { header },
    ctx: { tools: { view: () => view(names, names) } },
  }
}

test('a list-only 0.2.2 registry contributes its roots and never a child scope', () => {
  // The 0.2.2 AgentRegistry has no roots(): it answers list() with every live agent, so
  // membership has to come from the host's depth rule instead.
  const root = liveAgent({ id: 'root', names: ['exit_plan_mode', 'list_agents'] })
  // A persisted depth is the only record a cold-resumed child still carries.
  const resumed = liveAgent({ id: 'child-a', header: { delegationDepth: 1 }, names: ['worker_only'] })
  // A freshly spawned child carries it in its live options.
  const spawned = liveAgent({ id: 'child-b', depth: 1, names: ['worker_only'] })
  const ctx = {
    tools: { view: () => view(['read', 'edit']) },
    agents: { list: () => [resumed, spawned, root] },
  }
  assert.deepEqual(collectCatalog(ctx), ['edit', 'exit_plan_mode', 'list_agents', 'read'])
})

test('a GUI fork is a root even though it carries a parentSession', () => {
  // A fork is a new root session: parentSession set, delegation depth zero. The presence
  // of a parent must not drop its scope tools from the panel, or exit_plan_mode vanishes
  // on a forked conversation.
  const fork = liveAgent({ id: 'fork', header: { parentSession: 'origin' }, names: ['exit_plan_mode'] })
  const child = liveAgent({
    id: 'child',
    header: { parentSession: 'fork', delegationDepth: 1 },
    names: ['worker_only'],
  })
  const ctx = {
    tools: { view: () => view(['read']) },
    agents: { list: () => [fork, child] },
  }
  assert.deepEqual(collectCatalog(ctx), ['exit_plan_mode', 'read'])
})

test('legacy roots() is preferred, and its entries are filtered by the same depth rule', () => {
  let listCalls = 0
  const root = liveAgent({ id: 'root', names: ['subagent'] })
  const child = liveAgent({ id: 'child', depth: 1, names: ['worker_only'] })
  const ctx = {
    tools: { view: () => view(['read']) },
    agents: {
      roots: () => [root, child],
      list: () => {
        listCalls += 1
        return []
      },
    },
  }
  assert.deepEqual(collectCatalog(ctx), ['read', 'subagent'])
  assert.equal(listCalls, 0, 'a host that still has roots() is not asked for its full list')
})

test('a throwing or malformed roots() falls back to list(), and a doubly broken registry yields nothing', () => {
  const root = liveAgent({ id: 'root', names: ['exit_plan_mode'] })
  const throwingRoots = {
    tools: { view: () => view(['read']) },
    agents: {
      roots: () => {
        throw new Error('no roots')
      },
      list: () => [root],
    },
  }
  assert.deepEqual(collectCatalog(throwingRoots), ['exit_plan_mode', 'read'])

  const malformedRoots = {
    tools: { view: () => view(['read']) },
    agents: { roots: () => undefined, list: () => [root] },
  }
  assert.deepEqual(collectCatalog(malformedRoots), ['exit_plan_mode', 'read'])

  // No fallback ever widens the panel to every live agent: a broken list() contributes
  // no agent scopes at all, while the global view still publishes.
  const broken = {
    tools: { view: () => view(['read']) },
    agents: {
      roots: () => {
        throw new Error('a')
      },
      list: () => {
        throw new Error('b')
      },
    },
  }
  assert.deepEqual(collectCatalog(broken), ['read'])
  const neither = { tools: { view: () => view(['read']) }, agents: { get: () => undefined } }
  assert.deepEqual(collectCatalog(neither), ['read'])
  assert.deepEqual(rootAgents({ get: () => undefined }), [])
  assert.deepEqual(rootAgents(undefined), [])
})

test('a dirty depth is treated as absent instead of hiding a root', () => {
  // Mirrors gate.js: a negative, fractional, NaN or string depth is not a delegation
  // depth, so the agent stays a root and keeps its scope tools in the panel.
  const dirty = [
    liveAgent({ id: 'negative', depth: -1, names: ['list_agents'] }),
    liveAgent({ id: 'fractional', depth: 1.5, names: ['exit_plan_mode'] }),
    liveAgent({ id: 'string', header: { delegationDepth: '1' }, names: ['compress'] }),
  ]
  assert.deepEqual(
    rootAgents({ list: () => dirty }).map((agent) => agent.id),
    ['negative', 'fractional', 'string'],
  )
})

test('the catalog reports its roots by list() when roots() is absent, and by roots() when present', () => {
  const root = liveAgent({ id: 'root' })
  const child = liveAgent({ id: 'child', header: { delegationDepth: 1 } })
  assert.deepEqual(rootAgents({ list: () => [child, root] }), [root])
  assert.deepEqual(rootAgents({ roots: () => [root], list: () => [root, child] }), [root])
})

test('a newly listed root scope republishes the catalog and announces it', () => {
  const { ctx: base, config, events } = fakeHost()
  let live = [liveAgent({ id: 'root', names: ['subagent'] })]
  const ctx = {
    ...base,
    tools: { view: () => view(['read']) },
    agents: { list: () => live },
  }
  const publisher = createCatalogPublisher({ ctx, config })
  assert.deepEqual(publisher.publish(), { changed: true, names: ['read', 'subagent'] })
  assert.deepEqual(config[CATALOG_KEY].get(), ['read', 'subagent'])
  assert.deepEqual(events, [['settings/document-updated', 'orchestrator', 1]])

  // A new root (a fork or a second session) registering scope-local tools is a real
  // change: it is committed and the panel is told to re-read, with no timer involvement.
  live = [liveAgent({ id: 'root', names: ['subagent', 'exit_plan_mode', 'list_agents'] })]
  assert.deepEqual(publisher.publish(), {
    changed: true,
    names: ['exit_plan_mode', 'list_agents', 'read', 'subagent'],
  })
  assert.deepEqual(config[CATALOG_KEY].get(), ['exit_plan_mode', 'list_agents', 'read', 'subagent'])
  assert.deepEqual(events.at(-1), ['settings/document-updated', 'orchestrator', 2])
})

test('only a real volatile reference is writable', () => {
  assert.equal(isVolatileRef(volatileRef([])), true)
  assert.equal(isVolatileRef({ get: () => [] }), false)
  assert.equal(isVolatileRef(undefined), false)
  assert.equal(isVolatileRef('toolCatalog'), false)
})

/** A host-shaped ctx that records what the publisher announces. */
function fakeHost({ entry = 'orchestrator', names = ['read', 'delegate'] } = {}) {
  const events = []
  const ctx = {
    fiber: { entry: { id: entry } },
    emit: (event, ...args) => events.push([event, ...args]),
    logger: { warn: (message) => events.push(['warn', message]) },
  }
  const config = { [CATALOG_KEY]: volatileRef([]) }
  return { ctx, config, events, names, set: (next) => { names.splice(0, names.length, ...next) } }
}

test('publishing commits the catalog and announces the settings document once', () => {
  const host = fakeHost()
  const publisher = createCatalogPublisher({ ctx: host.ctx, config: host.config, collect: () => [...host.names].sort() })
  const first = publisher.publish()
  assert.deepEqual(first, { changed: true, names: ['delegate', 'read'] })
  assert.deepEqual(host.config[CATALOG_KEY].get(), ['delegate', 'read'])
  assert.deepEqual(host.events, [['settings/document-updated', 'orchestrator', 1]])
  assert.deepEqual(publisher.published(), ['delegate', 'read'])

  // The unchanged set publishes nothing at all: no write, no announcement, no gate refresh.
  assert.deepEqual(publisher.publish(), { changed: false, names: ['delegate', 'read'] })
  assert.deepEqual(host.events, [['settings/document-updated', 'orchestrator', 1]])

  host.set(['read', 'mcp__demo__ping'])
  assert.deepEqual(publisher.publish(), { changed: true, names: ['mcp__demo__ping', 'read'] })
  assert.equal(host.events.length, 2)
  assert.deepEqual(host.config[CATALOG_KEY].get(), ['mcp__demo__ping', 'read'])
})

test('the announced namespace is the plugin entry id, with a safe fallback', () => {
  const host = fakeHost({ entry: 'orchestrator-video' })
  const publisher = createCatalogPublisher({ ctx: host.ctx, config: host.config, collect: () => ['read'] })
  publisher.publish()
  assert.deepEqual(host.events[0], ['settings/document-updated', 'orchestrator-video', 1])

  const bare = fakeHost()
  bare.ctx.fiber = undefined
  const fallback = createCatalogPublisher({ ctx: bare.ctx, config: bare.config, collect: () => ['read'] })
  fallback.publish()
  assert.deepEqual(bare.events[0], ['settings/document-updated', 'orchestrator', 1])
})

test('a settings write that resets the field is restored, and announced', () => {
  const host = fakeHost()
  const publisher = createCatalogPublisher({ ctx: host.ctx, config: host.config, collect: () => ['delegate', 'read'] })
  assert.equal(publisher.publish().changed, true)
  assert.equal(host.events.length, 1)
  // A Loader volatile commit puts the profile's stored value back into every reference it
  // was handed, which is exactly what a panel write does to an unchanged catalog.
  host.config[CATALOG_KEY][VOLATILE_WRITE]([])
  assert.deepEqual(host.config[CATALOG_KEY].get(), [])
  assert.deepEqual(publisher.publish(), { changed: false, names: ['delegate', 'read'] })
  assert.deepEqual(host.config[CATALOG_KEY].get(), ['delegate', 'read'])
  assert.equal(host.events.length, 2)
  // With the reference holding the catalog again, another read is free.
  publisher.publish()
  assert.equal(host.events.length, 2)
})

test('an empty read is treated as a failed read, so the last catalog stays', () => {
  const host = fakeHost()
  let names = ['read']
  const publisher = createCatalogPublisher({ ctx: host.ctx, config: host.config, collect: () => names })
  assert.equal(publisher.publish().changed, true)
  names = []
  assert.deepEqual(publisher.publish(), { changed: false, names: ['read'] })
  assert.deepEqual(host.config[CATALOG_KEY].get(), ['read'])
  assert.equal(host.events.length, 1)
})

test('a throwing read is reported, never thrown', () => {
  const host = fakeHost()
  const publisher = createCatalogPublisher({
    ctx: host.ctx,
    config: host.config,
    collect: () => {
      throw new Error('registry exploded')
    },
  })
  assert.deepEqual(publisher.publish(), { changed: false, names: [] })
  assert.equal(host.events.length, 1)
  assert.match(host.events[0][1], /registry exploded/)
})

test('a host without a writable field is warned about once and otherwise ignored', () => {
  const host = fakeHost()
  const config = { [CATALOG_KEY]: [] }
  const publisher = createCatalogPublisher({ ctx: host.ctx, config, collect: () => ['read'] })
  assert.equal(publisher.writable, false)
  assert.equal(publisher.publish().changed, true)
  publisher.publish()
  host.set(['write'])
  publisher.publish()
  const warnings = host.events.filter(([kind]) => kind === 'warn')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0][1], /not a volatile reference/)
})

test('a burst of changes is one debounced publish', async () => {
  const host = fakeHost()
  let reads = 0
  const publisher = createCatalogPublisher({
    ctx: host.ctx,
    config: host.config,
    debounceMs: 5,
    collect: () => {
      reads += 1
      return [...host.names].sort()
    },
  })
  publisher.schedule()
  publisher.schedule()
  publisher.schedule()
  assert.equal(reads, 0)
  assert.equal(host.events.length, 0)
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(reads, 1)
  assert.equal(host.events.length, 1)
  assert.deepEqual(host.config[CATALOG_KEY].get(), ['delegate', 'read'])
  publisher.dispose()
})

test('dispose drops a pending read and a disposed publisher does nothing', async () => {
  const host = fakeHost()
  let reads = 0
  const publisher = createCatalogPublisher({
    ctx: host.ctx,
    config: host.config,
    debounceMs: 5,
    collect: () => {
      reads += 1
      return ['read']
    },
  })
  publisher.schedule()
  publisher.dispose()
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(reads, 0)
  assert.equal(host.events.length, 0)
  assert.deepEqual(publisher.publish(), { changed: false, names: [] })
})
