/**
 * DSH subagent-start compatibility.
 *
 * The plugin starts every worker through the host's subagent service, and that call
 * changed shape between DSH releases. The rules below were read from the shipped
 * `@deepseek-ai/dsh-subagent` service of each host, not from release notes:
 *
 * - DSH 0.2.1-rc.3 — `startActivation(spec)` reads the task from a nested `request`:
 *   `spec.request.parent.id`, `spec.request.maxDepth`, `spec.request.outputSchema`,
 *   `spec.request.cwd`, plus the activation's own `spec.provider`, `spec.label`,
 *   `spec.signal` and `spec.delivery`. This is the spec `worker.js` has always built.
 * - DSH 0.2.2-rc.3 — `startActivation(spec)` is flat: `spec.parent.id`, `spec.maxDepth`,
 *   `spec.outputSchema`, `spec.prompt`, `spec.cwd`, `spec.agentOptions`, `spec.childId`,
 *   `spec.label`, `spec.signal`, `spec.delivery`. A nested `spec.request` leaves
 *   `spec.parent` undefined, so the service throws before it creates any child.
 * - DSH 0.2.0-rc.3 — no `startActivation`; `startContinuable(spec)` for a continuable
 *   child and `start(provider, request)` for a one-shot one.
 *
 * Choosing the shape: 0.2.2 removed the symbol-keyed `dsh.subagent.deliverPrompt`
 * entry, and the same release is the one that flattened `startActivation`. A host that
 * still carries that entry therefore reads the nested spec, and a host without it that
 * exposes the public `prompt` control face reads the flat one. Both shapes are validated
 * before a child exists, so a wrong pick fails loudly instead of starting a stray worker.
 * With neither marker, the nested spec this plugin has always sent is kept.
 *
 * This module is deliberately dependency-free; the caller passes the live service.
 */

/** The 0.2.1 plugin-authored delivery entry; its presence marks the nested-spec host. */
export const DELIVER_PROMPT = Symbol.for('dsh.subagent.deliverPrompt')

/** The two spec shapes a modern `startActivation` accepts. */
export const ACTIVATION_SHAPE = Object.freeze({ nested: 'nested', flat: 'flat' })

/**
 * Reject anything that is not a plain spec object before a host sees it.
 * @param value - candidate spec or request.
 * @param what - name used in the message.
 * @throws TypeError when the value is not a non-array object.
 */
function assertSpecObject(value, what) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`orchestrator: the activation ${what} must be an object`)
  }
}

/**
 * Which `startActivation` spec shape this host reads.
 * @param subagents - the live `ctx.subagents` service, or a test double.
 * @returns `'nested'` for a host that still carries the 0.2.1 delivery entry or shows no
 *   generation marker at all, `'flat'` for a 0.2.2+ host.
 */
export function activationShape(subagents) {
  if (subagents === null || typeof subagents !== 'object') return ACTIVATION_SHAPE.nested
  if (typeof subagents[DELIVER_PROMPT] === 'function') return ACTIVATION_SHAPE.nested
  if (typeof subagents.prompt === 'function') return ACTIVATION_SHAPE.flat
  return ACTIVATION_SHAPE.nested
}

/**
 * Flatten the legacy `{ provider, label, request, signal, delivery }` spec into the flat
 * activation spec 0.2.2+ consumes. An already-flat spec is returned unchanged (identity),
 * so a current host never sees its own input reshaped.
 *
 * The outer fields describe the activation itself (which backend, which recipient, how the
 * result is delivered), so they win over a same-named field carried inside `request`; no
 * `request` key survives, because the flat contract has none.
 *
 * @param spec - activation spec built by `worker.js` (legacy or flat).
 * @returns the flat spec a DSH 0.2.2+ `startActivation` takes.
 * @throws TypeError when the spec or its `request` member is not an object.
 */
export function flattenActivationSpec(spec) {
  assertSpecObject(spec, 'spec')
  if (spec.request === undefined) return spec
  const { request, ...outer } = spec
  assertSpecObject(request, 'request')
  return { ...request, ...outer }
}

/**
 * The inverse: rebuild the nested 0.2.1 spec from a flat one, for a caller that holds a
 * flat spec while the host still reads `spec.request`. A spec that already carries
 * `request` is returned unchanged (identity).
 *
 * @param spec - a flat or nested activation spec.
 * @returns the nested spec a DSH 0.2.1 `startActivation` takes.
 * @throws TypeError when the spec is not an object.
 */
export function nestActivationSpec(spec) {
  assertSpecObject(spec, 'spec')
  if (spec.request !== undefined) return spec
  const { provider, label, signal, delivery, ...request } = spec
  const nested = { provider, request }
  // An absent outer field stays absent: the host distinguishes "not given" from an
  // explicit undefined, and 0.2.1 only treats delivery === 'caller' specially.
  if (label !== undefined) nested.label = label
  if (signal !== undefined) nested.signal = signal
  if (delivery !== undefined) nested.delivery = delivery
  return nested
}

/**
 * Build the spec for one host generation.
 * @param shape - `'nested'` or `'flat'`, from {@link activationShape}.
 * @param spec - a flat or nested activation spec.
 * @returns the spec that shape's `startActivation` reads.
 */
export function buildActivationSpec(shape, spec) {
  return shape === ACTIVATION_SHAPE.flat ? flattenActivationSpec(spec) : nestActivationSpec(spec)
}

/**
 * Start one continuable child, preferring `startActivation` when the host has it.
 * @param subagents - the live `ctx.subagents` service.
 * @param spec - the spec `worker.js` built (nested, or flat for a caller that has one).
 * @returns whatever the host returns: a promise of an activation handle carrying
 *   `childId`, `messageId`, `result` and `dispose`.
 * @throws Error when the host exposes neither start entry.
 */
export function startContinuableCompat(subagents, spec) {
  assertSpecObject(spec, 'spec')
  if (typeof subagents?.startActivation === 'function') {
    const shape = activationShape(subagents)
    return subagents.startActivation(buildActivationSpec(shape, spec))
  }
  if (typeof subagents?.startContinuable === 'function') {
    // 0.2.0 reads the legacy spec directly and ignores the newer `delivery` field; its
    // continuable children already hand their closing message to the parent.
    return subagents.startContinuable(spec)
  }
  throw new Error('orchestrator: the host exposes neither startActivation nor startContinuable')
}

/**
 * Start one one-shot worker and return the handle carrying `.result` / `.dispose()`.
 * @param subagents - the live `ctx.subagents` service.
 * @param spec - the spec `worker.js` built (nested, or flat for a caller that has one).
 * @returns whatever the host returns: a promise of a handle with `result`.
 * @throws Error when the host exposes neither start entry.
 */
export function startOneShotCompat(subagents, spec) {
  assertSpecObject(spec, 'spec')
  if (typeof subagents?.startActivation === 'function') {
    const shape = activationShape(subagents)
    return subagents.startActivation(buildActivationSpec(shape, spec))
  }
  if (typeof subagents?.start === 'function') {
    // The 0.2.0 one-shot entry takes `(provider, request)` and knows neither `delivery`
    // nor the outer `provider`, so the request is rebuilt from the canonical shape.
    const nested = nestActivationSpec(spec)
    const request = {
      ...nested.request,
      ...(nested.label === undefined ? {} : { label: nested.label }),
      signal: nested.signal,
    }
    return subagents.start(nested.provider, request)
  }
  throw new Error('orchestrator: the host exposes neither startActivation nor start')
}
