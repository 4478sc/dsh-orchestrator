# Host compatibility (DSH 0.2.1 / 0.2.2)

This document records **what the plugin must adapt to, why, and what has actually been
verified**. The compatibility layer lives in two files:

- `lib/start-compat.js` — how a worker is started (`startActivation` spec shape, legacy
  fallbacks).
- `lib/deliver-compat.js` — how a retry prompt is queued on an existing child.

## "DSH version" means the package version

`0.2.1-rc.3` and `0.2.2-rc.3` are **`@deepseek-ai/dsh` package versions** — the number the
plugin manager checks against `peerDependencies`. They are not Electron, Chromium or
desktop-app versions, and they do not change the plugin's own `0.8.0` version. Two hosts
that look identical in the About/“About this app” panel can still load different DSH package
versions.

## What changed between 0.2.1 and 0.2.2

The rules below were read from the shipped `@deepseek-ai/dsh-subagent` service of each
host (the `startActivation`, `prompt`, `sendMessage` and control-schema definitions), not
from release notes.

### 1. `startActivation` spec shape

| DSH | Entry | Spec the service reads |
| --- | --- | --- |
| 0.2.0-rc.3 | `startContinuable(spec)` / `start(provider, request)` | legacy nested spec |
| 0.2.1-rc.3 | `startActivation(spec)` | **nested**: `spec.request.parent.id`, `spec.request.maxDepth`, `spec.request.outputSchema`, `spec.request.cwd`, plus outer `spec.provider`, `spec.label`, `spec.signal`, `spec.delivery` |
| 0.2.2-rc.3 | `startActivation(spec)` | **flat**: `spec.parent.id`, `spec.maxDepth`, `spec.outputSchema`, `spec.prompt`, `spec.cwd`, `spec.agentOptions`, `spec.childId`, `spec.label`, `spec.signal`, `spec.delivery` |

`worker.js` builds the nested spec, which is why 0.8.0 worked unchanged on 0.2.1. On 0.2.2 a
nested spec leaves `spec.parent` undefined, so the service throws a `TypeError` **before it
creates any child** — this is a loud failure, not a half-started worker.

### 2. Choosing the shape at runtime

`0.2.2` removed the symbol-keyed delivery entry `Symbol.for('dsh.subagent.deliverPrompt')`,
and the same release flattened `startActivation`. `activationShape()` therefore keys on
those two markers:

| Marker on `ctx.subagents` | Shape used |
| --- | --- |
| `[Symbol.for('dsh.subagent.deliverPrompt')]` is a function | nested (0.2.1 and older) |
| no symbol entry, but `prompt` is a function | flat (0.2.2+) |
| neither marker | nested — the spec 0.8.0 has always sent, kept so an unknown host fails the way it always did instead of silently changing shape |

Both shapes are validated before a child exists, so a wrong pick is a `TypeError`, never a
stray worker. The plugin does not guess from a version string, and it does not send a spec
containing both shapes.

### 3. Retry delivery (`deliver-compat.js`)

A retry must be a **new turn** on the same durable child, so the ranking is:

| DSH | Channel | Notes |
| --- | --- | --- |
| 0.2.1-rc.3 | `subagents[Symbol.for('dsh.subagent.deliverPrompt')](parent, childId, content, source, signal, 'queue')` | `parent` must be the exact live parent Agent; `source` is the durable host-protocol descriptor. Preferred whenever present. |
| 0.2.2-rc.3 | `subagents.prompt({ requestId, childSessionId, delivery: 'queue', content }, signal)` → `{ messageId }` | Authorizes on the target Session, so the parent need not be resident. The 0.2.1 control schema for the same method also required `parentSessionId` and `mode: 'continuable'`; 0.2.2 dropped both, so this request carries neither. |
| both | `subagents.sendMessage(sender, targetId, content, { signal })` | Steers at the nearest step and needs the exact live sender, so it is a **documented degradation**, marked with a prefix in the text. Used only when neither queueing channel exists. |

A host refusal is re-thrown with the channel name, the host `code` and `cause` intact, so
the retry notice the parent reads names the real reason.

### 4. Tool catalog root enumeration (`roots()` in 0.2.1, `list()` in 0.2.2)

The Allowed Tools panel is rendered by the web client, which cannot enumerate the host's
tools itself. The plugin therefore publishes a **read-only catalog** through its own config
field (`toolCatalog`, see `lib/catalog.js`): the union of the context-global registry view
and each **live root agent's** scope view. The root scopes are the only place a preset or
scope-local tool — `exit_plan_mode`, `list_agents`, the native `subagent`, every `ops_*` —
becomes visible, so finding the roots correctly is what puts those rows in the panel.

The two host generations expose the live agents differently (checked in the shipped
`@deepseek-ai/dsh-agent` package of each host, not from release notes):

| DSH | Live-agent API | What the plugin does |
| --- | --- | --- |
| 0.2.1-rc.3 and earlier | `agents.roots()` | Used first; an array is taken as the root set. |
| 0.2.2-rc.3 | `agents.get(id)` and `agents.list()` only — the `AgentRegistry` class has no `roots()` | `list()` is filtered to roots by the host's own depth rule. |

The filter mirrors the host's `delegationDepthOf` /
`isDelegatedChild` (`lib/gate.js`): the effective depth is
`max(agent.options.subagentDepth ?? 0, agent.session.header.delegationDepth ?? 0)`, and an
agent is a root exactly when that is zero. Two consequences matter:

- **A GUI fork is a root.** It carries a `parentSession` but a depth of zero, so it is not
  excluded by looking at `parentSession`; its scope tools stay listable.
- **A cold-resumed child is not.** Its `subagentDepth` option is gone after a resume, but the
  persisted `session.header.delegationDepth` still records it, so it stays excluded and its
  scope's private tools never reach the main agent's panel.

Failure handling is deliberately narrow: a throwing `roots()` falls through to `list()`, a
throwing or malformed `list()` contributes **no agent scopes**, and the global view is still
published. There is no "all live agents" fallback — that would leak child scopes into the
main agent's panel. The catalog is display input only: it grants nothing (see the next
section's note in the READMEs about `toolCatalog` vs `allowedTools`).

## Verification boundary

Read this before quoting any of the above as "works on version X".

| Claim | Status |
| --- | --- |
| VM host `DSH 0.2.2-rc.3`: dynamic `delegate`, `orchestrate` and plan approval worked with the **earlier single-shape compat build** | **Live-verified before this branch.** The plan-mode approval button was also confirmed by the user on that VM. |
| The dual-shape layer in **this branch** | **Contract-tested only.** Its suites drive host doubles whose first read matches the shipped service, plus the production spec producer. No live run of this branch's build was performed on a real host. |
| Windows host `DSH 0.2.1-rc.3`: the **original, unmodified** 0.8.0 plugin ran normally | **Historical observation.** It is evidence for the nested shape; it is not a run of this branch. |
| `startContinuable` / `start` fallback for 0.2.0-rc.3 | **Retained, not re-verified** on a real host in this round. |
| Catalog root enumeration (`roots()` vs `list()`) | **Contract-tested** against a roots-only registry, a list-only 0.2.2 registry (persisted depth, live depth, GUI fork), a throwing/malformed registry and the catalog update event. The 0.2.2 `AgentRegistry` shape (no `roots()`, `list()` present) was read from the shipped package. The panel rendering itself was not re-verified live in this branch. |
| CI | **No claim.** No workflow run of this branch is asserted here. |

Repeating the live check is a good idea before tagging a release: install the tarball on a
0.2.1 host and on a 0.2.2 host, then follow the acceptance list below.

## Upgrade checklist

DSH upgrades can rewrite or reset profile state. Do these in order.

1. **Back up the profile patch first** — `cordis.patch.yml` and the profile's
   `package.json` (and `pnpm-lock.yaml` if present) into a dated folder outside the profile.
   Restore them if the plugin fails to load after the upgrade.
2. Upgrade DSH, then re-check **`enabled`**: an upgrade may leave orchestration mode off
   (the main agent then keeps every host tool) or on with an unset route.
3. Re-check the **worker route** (`workerProvider` / `workerModel` / `workerReasoningEffort`).
   An empty route is refused at dispatch time by design; it never falls back to the main
   model.
4. Re-check **`allowedTools`**. The shipped default is 12 names:
   `delegate`, `orchestrate`, `send_message`, `interrupt_agent`, `todo_write`,
   `ask_user_question`, `compress`, `session_search`, `session_trace`,
   `session_event_search`, `session_event_read`, `session_event_trace`.
   Add `exit_plan_mode` and `list_agents` when plan approval and child listing are used.
   A list written in the profile **replaces** the default as a whole — it is not merged, not
   incremental. A shorter list therefore silently removes tools the default would have
   granted, and "Reset to defaults" (or deleting the field) returns to the 12 built-ins.
   Matching is by exact registered name: a name listed in `toolCatalog` (what the panel can
   show) is not allowed until it is also written into `allowedTools`, and a typo there
   silently never applies.
5. Do not assume the panel's checkboxes were persisted: after an upgrade or a plugin reload,
   compare what the panel shows with the value in the profile (or re-select the boxes), and
   confirm a tool you expect is actually callable.

Profile repair is **profile configuration**, not a repository code change: the plugin
already reads `enabled`, `allowedTools` and the worker route live, so the fix belongs in the
profile file or the panel. Do not patch `lib/` to make one machine's profile work.

### Example profile patch (example only — pick your own route)

The repository's own `cordis.patch.yml` is what installs the plugin and must stay as
shipped. A profile that needs extra configuration looks like this; the route values below
are **placeholders**, not recommendations — choose the provider and model yourself:

```yaml
# <profile>/cordis.patch.yml — example, adjust to your own host
- insert:
    - id: orchestrator
      name: dsh-orchestrator
```

```yaml
# example config block; workerProvider/workerModel must be a route YOUR host offers
orchestrator:
  enabled: true
  workerProvider: <your-worker-provider>   # e.g. the provider id shown in your panel
  workerModel: <your-worker-model>         # e.g. the cheap model you chose
  allowedTools:
    - delegate
    - orchestrate
    - send_message
    - interrupt_agent
    - todo_write
    - ask_user_question
    - compress
    - session_search
    - session_trace
    - session_event_search
    - session_event_read
    - session_event_trace
    - exit_plan_mode
    - list_agents
```

The example repeats the shipped 12 defaults in full and appends the two scope-local names,
because the field replaces the default instead of extending it. The provider/model values are
placeholders, not recommendations; the repository's own defaults are not changed for any
specific host or private route.

## Minimum acceptance after an upgrade

A human has to click the approval buttons; an agent cannot accept on its own.

1. **delegate** — dispatch one trivial worker ("print the current directory") and confirm the
   tool returns a `subagentId` instead of a start error.
2. **orchestrate** — run one two-item, single-stage batch and confirm both items settle with
   a result or a per-item error (a batch never fails the whole run for one item).
3. **plan approval** — enter plan mode, have the agent call `exit_plan_mode`, and confirm the
   approve/reject buttons appear and the plan leaves plan mode when approved.
4. **retry delivery** — optional; it only appears when a child dies without a closing
   message.

### What an error means

- `401` / authentication / "model pool" / quota errors are **service-credential or route
  problems**, not compatibility failures. Fix the provider credential or the route.
- `TypeError: Cannot read properties of undefined (reading 'id')` from a start call means
  the spec shape did not match the host — include the host's DSH package version when
  reporting it.
- `the host exposes neither startActivation ...` means the host is older than 0.2.0-rc.3 or
  is not a full DSH subagent service.
