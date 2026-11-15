/**
 * Retry delivery across DSH host versions.
 *
 * A retry is one *new turn* on the same durable child, so it must not degrade into a
 * mid-turn steer. The signatures below were read from the shipped
 * `@deepseek-ai/dsh-subagent` service of each host:
 *
 * - DSH 0.2.1-rc.3 keeps the plugin-authored, symbol-keyed entry
 *   `subagents[Symbol.for('dsh.subagent.deliverPrompt')](parent, childId, content, source, signal, delivery)`.
 *   `source` is a durable host-protocol descriptor, `delivery: 'queue'` starts a distinct
 *   turn, and `parent` must be the exact live parent Agent.
 * - DSH 0.2.2-rc.3 removed that entry. The same service keeps the public control face
 *   `subagents.prompt({ requestId, childSessionId, delivery, content }, signal)`, which
 *   mints `{ messageId }`, authorizes on the target Session (so the parent need not be
 *   resident) and cold-resumes an absent child with `delivery: 'queue'`. The 0.2.1
 *   control schema for that method also required `parentSessionId` and
 *   `mode: 'continuable'`; 0.2.2 dropped both, which is why this request carries neither
 *   and is only minted after the symbol entry proved absent.
 * - Both versions keep `subagents.sendMessage(sender, targetId, content, { signal })`.
 *   It needs the exact live sender and steers at the nearest step, so it is a documented
 *   degradation — the text is marked so the child can tell it from a fresh turn.
 *
 * Nothing here writes onto `ctx`, patches a prototype or fabricates an Agent to impersonate
 * the parent. A host refusal is re-thrown with its own `code` and `cause` preserved, because
 * the retry policy turns the message into the notice the parent reads.
 * See `docs/host-compatibility.md` for the version-by-version table.
 */

import { randomUUID } from 'node:crypto'
import { RETRY_SOURCE_KIND } from './retry.js'

/** The 0.2.1 symbol entry; kept so an older host keeps its exact behaviour. */
export const DELIVER_PROMPT = Symbol.for('dsh.subagent.deliverPrompt')

/** Marks the text of a degraded `sendMessage` retry, so the child can tell the two apart. */
export const STEER_FALLBACK_PREFIX = '（兼容模式：steer 投递，非独立回合）'

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Wrap a host refusal so the notice names the channel and keeps the host code.
 * @param channel - the service method that refused.
 * @param error - whatever the host threw.
 * @returns an Error whose `message` reads as a reason and whose `code`/`cause` survive.
 */
function deliveryError(channel, error) {
  const code = error !== null && typeof error === 'object' ? error.code : undefined
  const detail = messageOf(error)
  const wrapped = new Error(
    typeof code === 'string'
      ? `${channel} refused the retry prompt (${code}): ${detail}`
      : `${channel} failed to deliver the retry prompt: ${detail}`,
  )
  if (typeof code === 'string') wrapped.code = code
  wrapped.cause = error
  return wrapped
}

/**
 * Queue one plugin-authored turn on a delegated child, cold-resuming it when it is gone.
 * Exported so the adapter can be driven with plain objects instead of a running host.
 *
 * @param ctx - host services; only `subagents` and (for the legacy and steer paths)
 *   `agents` are read.
 * @param parentId - durable id of the main agent that owns the retry notice.
 * @param childId - durable id of the delegated child to wake.
 * @param text - the retry prompt text.
 * @param options - `sourceKind` (legacy attribution, default `orchestrator-retry`) and
 *   `signal` (cancellation; defaults to a fresh never-aborted signal).
 * @returns whatever the chosen host channel resolves: a message id, or the legacy entry's value.
 * @throws when every channel is absent or the chosen channel refuses the prompt.
 */
export async function deliverRetryPrompt(ctx, parentId, childId, text, options = {}) {
  const sourceKind =
    typeof options.sourceKind === 'string' && options.sourceKind !== ''
      ? options.sourceKind
      : RETRY_SOURCE_KIND
  const signal = options.signal ?? new AbortController().signal
  const subagents = ctx === null || ctx === undefined ? undefined : ctx.subagents
  const content = [{ type: 'text', text }]

  if (subagents !== null && typeof subagents === 'object') {
    // 1. DSH 0.2.1: the plugin-authored entry keeps its durable source descriptor.
    const legacy = subagents[DELIVER_PROMPT]
    if (typeof legacy === 'function') {
      const parent = ctx?.agents?.get?.(parentId)
      if (parent === undefined || parent === null) throw new Error(`the main agent ${parentId} is not live`)
      return legacy.call(subagents, parent, childId, content, { kind: sourceKind, form: 'notice' }, signal, 'queue')
    }

    // 2. DSH 0.2.2: the public control face queues a distinct turn and cold-resumes the child.
    if (typeof subagents.prompt === 'function') {
      const request = {
        // The host persists this identity on the accepted message, so it must be unique per
        // call: a repeated request id would look like a redelivery of the same human prompt.
        requestId: `orchestrator-retry-${randomUUID()}`,
        childSessionId: childId,
        delivery: 'queue',
        content,
      }
      try {
        const receipt = await subagents.prompt(request, signal)
        return receipt === null || typeof receipt !== 'object' ? receipt : receipt.messageId
      } catch (error) {
        throw deliveryError('subagents.prompt', error)
      }
    }

    // 3. Degradation: a live parent can steer the child, but this is not a fresh turn.
    if (typeof subagents.sendMessage === 'function') {
      const parent = ctx?.agents?.get?.(parentId)
      if (parent !== undefined && parent !== null) {
        try {
          return await subagents.sendMessage(
            parent,
            childId,
            [{ type: 'text', text: STEER_FALLBACK_PREFIX + text }],
            { signal },
          )
        } catch (error) {
          throw deliveryError('subagents.sendMessage', error)
        }
      }
      throw new Error(
        `the main agent ${parentId} is not live, so subagents.sendMessage (the only remaining channel) cannot be used`,
      )
    }
  }

  throw new Error(
    'the host exposes neither dsh.subagent.deliverPrompt nor subagents.prompt, and subagents.sendMessage is unavailable',
  )
}
