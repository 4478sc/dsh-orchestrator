# DSH Orchestrator

[![version](https://img.shields.io/badge/version-0.8.0-4176E6?style=flat-square)](https://github.com/SShiRkiT/dsh-orchestrator)

The "dispatch mode" plugin for DeepSeek Harness.
  
  The main agent only clarifies, plans, slices work, and accepts results
    
  Every concrete action is handed to subagents through `delegate` (asynchronous, on demand) or `orchestrate` (declarative batch).
    
  The main agent and the subagents have their default models and reasoning effort configured independently, and all subagents share the same subagent route.

[中文](README.md)

## How it differs from a plain single-agent session

| | Plain single-agent session | Dispatch mode |
| --- | --- | --- |
| Who executes | the main model calls tools itself | workers execute; the main agent only dispatches |
| Context | tool output piles up in the main agent context | each worker carries its own context |
| Parallelism | tool calls complete one after another | several workers run at once |
| Models | one model does everything | two routes, main agent and subagent |
| Boundaries | the model is expected to comply | the gate refuses by force |


## Key features

- **The main agent only plans, enforced by a gate**:
  
     a whitelist of 12 built-in planning and delegation tools (`DEFAULT_ALLOWED_TOOLS` / `allowedTools`) is all the main agent may call; every read, write, shell, web, and other host tool — plus any MCP or third-party plugin tool registered later — is hidden and refused at execution time (even a nested call smuggled through `run_code`); the main agent keeps only `delegate`, `orchestrate`, `send_message`, `todo_write`, `ask_user_question`, `compress`, `interrupt_agent`, plus the read-only session log tools (`session_*`).
  
- **Parallel dispatch of independent subtasks**:

    Independent subtasks go out together in the same turn; `delegate` has no plugin-side concurrency cap, while `orchestrate` limits how many workers are alive at once with `maxConcurrency` (1–16, default 4).
  
- **Supervision and correction**:
  
    When a `delegate` worker runs long, the plugin merges its session log into one notice that wakes the main agent; the main agent corrects it with a concrete `send_message`, or decides no intervention is needed and ends the turn with a one-line note.

    When a worker is interrupted with `interrupt_agent` and later woken again by `send_message`, supervision takes it back: the notice count restarts from the first notice, and the log from before the interruption does not count as new activity.
  
    ![Example patrol notice and correction](docs/images/patrol-notice.png)
  
    *Each patrol notice summarises one running subagent — elapsed time, rounds, steps, new tool calls since the last patrol, latest tool, and last output — and the main agent then chooses to leave it alone (replying one line 「巡检：正常」), correct it with `send_message`, or terminate. In the screenshot the main agent sends corrective guidance to a subagent stuck on shell quoting and backslashes.*
  
- **Collecting results**:

    `delegate` returns `{ kind: "activation", subagentId }` immediately, and when the worker finishes the host delivers its result to the main agent as a message; `orchestrate` collects every result synchronously inside the tool call.
  
- **Declarative orchestration**:

    `orchestrate` does single-stage fan-out and multi-stage per-item pipelines (no global barrier); results keep input order, one failed item does not sink the others, and a stage can declare an object schema for structured results.

## Install

Add it from GitHub in the DSH plugin page — all three spellings are accepted, and the full URL is the least ambiguous:

```text
https://github.com/SShiRkiT/dsh-orchestrator
github:SShiRkiT/dsh-orchestrator#main
SShiRkiT/dsh-orchestrator#main
```

```bash
# equivalent CLI install
dsh plugin --profile desktop add https://github.com/SShiRkiT/dsh-orchestrator
```

After installing, **fully quit and reopen DSH**: client plugins are composed at startup and are not hot-updated. When upgrading, **remove the old version first** and then add this repository — two copies registering the same tools will fight over the same declarations.

## Host compatibility and upgrade notes (DSH 0.2.1 / 0.2.2)

`0.2.1` and `0.2.2` here are **`@deepseek-ai/dsh` package versions** — the number the plugin
manager checks against `peerDependencies`. They are not Electron or desktop-app versions and
they do not change the plugin's own `0.8.0`. Two machines can look identical in the About
panel and still load different DSH package versions.

The plugin aligns with the real APIs of both host generations in `lib/start-compat.js` and
`lib/deliver-compat.js` (every signature below was read from the `@deepseek-ai/dsh-subagent`
service shipped with that host):

- **Starting a worker**: DSH 0.2.1's `startActivation(spec)` reads the nested
  `spec.request.parent.id / maxDepth / outputSchema / cwd` plus the outer
  `provider / label / signal / delivery`; 0.2.2 reads the same values flat, as
  `spec.parent.id / maxDepth / outputSchema / prompt`. The plugin picks the shape from the
  host's own markers: a host that still carries
  `Symbol.for('dsh.subagent.deliverPrompt')` is 0.2.1-or-older (nested), a host without it
  that exposes `prompt` is 0.2.2+ (flat). Both shapes are validated **before a child is
  created**, so a wrong pick is a loud error, never a half-started worker.
- **Retry delivery**: 0.2.1 uses the symbol entry
  `deliverPrompt(parent, childId, content, source, signal, 'queue')`; 0.2.2 removed that entry
  and the plugin uses `prompt({ requestId, childSessionId, delivery: 'queue', content })`
  instead, which authorizes on the target session and needs no resident parent. The
  `sendMessage` channel both versions keep is only a degraded steer and its text says so.
- **The 0.2.0 fallback** (`startContinuable` / `start`) is retained, but it was **not**
  re-exercised on a real host in this round.
- **Tool-catalog root enumeration**: DSH 0.2.1 and earlier exposed `agents.roots()`; 0.2.2 has
  only `agents.list()`, which returns **every live agent**, delegated children included. The
  plugin prefers `roots()`, and on a `list()`-only host filters the roots first with the
  host's own depth rule (`max(options.subagentDepth, session.header.delegationDepth)`) before
  reading each scope's registered tools. A GUI fork therefore stays a main agent (it carries
  a `parentSession` but a depth of zero) and keeps its scope tools in the panel, while a
  child scope's private tools never leak into it. An unreadable or throwing registry
  contributes no agent scopes — it is **never** widened to "every live agent". This is what
  makes scope-local tools such as `exit_plan_mode` and `list_agents` visible in Allowed Tools.

### What has actually been verified

- **Live-verified on the VM**, host `DSH 0.2.2-rc.3`: dynamic `delegate`, `orchestrate` and
  plan approval all worked, and the plan-approval button was confirmed by the user. That run
  used the **earlier single-shape compat build**.
- **This branch**: the dual-shape layer and the catalog's root enumeration are
  **contract/regression tested only** — `node --test --test-isolation=none`, 381 tests
  passing, covering the 0.2.1 nested contract, the 0.2.2 flat contract, the
  no-`startActivation` fallback, route / parent / cwd / maxDepth / outputSchema / delivery /
  signal pass-through, `receipt.result`, failure propagation and every delivery channel, plus
  the `roots()` / `list()` root enumerations, persisted depth, GUI forks, broken registries
  and catalog update events. **No live run of this branch's build against the changed tool
  catalog was performed** (the host runtime needs a restart to load this build; see the PR
  notes), so it must not be described as "the final PR build passed end-to-end on a real
  machine".
- **Windows `0.2.1-rc.3`**: that host ran the **original, unmodified** plugin normally. That is
  historical evidence for the nested shape; it is not a run of this branch.
- The 0.2.0 fallback was not re-tested in this round, and no "CI is green" claim is made before
  the repository's workflow has actually run on this branch.

### Checklist before and after an upgrade

1. **Back up the profile patch first**: copy the profile's `cordis.patch.yml` and
   `package.json` (and `pnpm-lock.yaml` when present) into a dated folder outside the
   profile; restore them first if the plugin fails to load.
2. Re-check **`enabled`** after the upgrade — it may be reset to off (the main agent keeps
   every tool again) or left on with an empty route.
3. Re-check the **worker route** (`workerProvider` / `workerModel` / `workerReasoningEffort`):
   an empty route fails at dispatch time by design and never silently falls back to the
   expensive main model.
4. Re-check **`allowedTools`**: the shipped default is 12 names (`delegate`, `orchestrate`,
   `send_message`, `interrupt_agent`, `todo_write`, `ask_user_question`, `compress` and the
   five read-only session tools); add `exit_plan_mode` when plan approval is used and
   `list_agents` when children are listed. **A list written in the profile replaces the
   default as a whole — it is not merged incrementally**, so a shorter list silently removes
   tools the default would have allowed, and "Reset to defaults" (or deleting the field)
   returns to the 12 built-ins, dropping both scope-local names again. **A name you can see in
   the panel is not a name that is allowed**: only what is written into `allowedTools` (exact
   match) is granted.
5. **Do not assume the panel's checkboxes were persisted**: after an upgrade or a plugin
   reload, compare the panel with the value actually in the profile (re-select the boxes if
   needed) and then confirm a tool you rely on is really callable.

> Repairing a profile is **configuration, not a repository code change**: the plugin already
> reads `enabled`, `allowedTools` and the worker route live, so the fix belongs in the profile
> or the panel — never in `lib/` for one machine. An example profile is in
> [docs/host-compatibility.md](docs/host-compatibility.md); its provider and model are
> placeholders, so pick a route your own host offers. The plugin does not fix any route and
> does not hard-code any private model into its repository defaults.

### `toolCatalog` vs `allowedTools` (visible is not allowed)

- **`toolCatalog`** is a **read-only snapshot** of the host's tool registry: the global tools
  plus every tool a live root agent's scope registers (`exit_plan_mode`, `list_agents`, the
  native `subagent`, `ops_*`, …). It exists so the panel can render a complete checklist; it
  never writes the profile and never grants anything.
- **`allowedTools`** is the whitelist the gate actually enforces, matched by **exact tool
  name** (no prefix, glob or substring matching). A name outside it is hidden and refused at
  execution time even when it is listed in `toolCatalog`; a name inside it that the host never
  registered does not error — it simply never applies. So a tool is usable only when the host
  registers it **and** `allowedTools` contains it.
- **Replacement, not merge**: once `allowedTools` is written explicitly it replaces the 12
  built-in defaults as a whole; the other fields (`enabled`, the worker route, …) are kept.

A complete example (the provider/model are placeholders — use a route your own host offers):

```yaml
# <profile>/cordis.patch.yml — only the relevant block; keep your other entries as they are
- id: orchestrator
  name: dsh-orchestrator
  config:
    enabled: true
    workerProvider: <your-worker-provider>   # e.g. the provider id shown in your panel
    workerModel: <your-worker-model>         # e.g. the cheap model you chose
    workerReasoningEffort: ""
    superviseIntervalSeconds: 600
    allowedTools:
      # -- the 12 built-in defaults: an explicit list has to repeat them in full --
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
      # -- optional scope-local tools: the host must register them AND they must be listed --
      - exit_plan_mode
      - list_agents
```

> This list is **your machine's profile configuration**, not a repository default: the shipped
> `DEFAULT_ALLOWED_TOOLS` stays at 12 names and is not changed for one host or one private
> route.

### Minimum acceptance after an upgrade

Approval buttons need a human click; an agent cannot accept on your behalf.

1. **delegate** — dispatch one trivial task ("print the current directory") and confirm it
   returns a `subagentId` instead of a start error.
2. **orchestrate** — run one two-item, single-stage batch and confirm both items settle with a
   result or a per-item error (one failed item never sinks the batch).
3. **plan approval** — enter plan mode, have the agent call `exit_plan_mode`, and confirm the
   approve/reject buttons appear and that approving leaves plan mode. Whether that button
   appears is confirmed by the user on their own host, never assumed.
4. **retry delivery** — optional; it only fires when a child dies without a closing message.

Reading an error: `401` / authentication / model-pool / quota failures are **service-credential
or route problems**, not compatibility failures. A start-time `TypeError` such as
`Cannot read properties of undefined (reading 'id')` is a spec-shape mismatch — report it with
the host's DSH package version.

The full API differences and the verification boundary are in
[docs/host-compatibility.md](docs/host-compatibility.md).

## Enable

1. Dispatch mode is already on after installing and restarting (`enabled` defaults to `true`).
2. In the composer's "Dispatch mode" panel, configure `workerProvider` and `workerModel` (required) and `workerReasoningEffort` (may stay empty, letting the model resolve its default effort); dispatching without a route fails outright instead of silently inheriting the main-agent model.
3. Turning off the "Enable dispatch mode" switch temporarily restores all main-agent tools and applies to already-open sessions immediately.
4. The Allowed Tools list on the right of the panel names every tool the host currently offers — read live at start and again whenever the registry changes, so tools another plugin or an MCP server registers are listed too: check a row to allow the main agent to use that tool, uncheck it to block it, and anything left unchecked — including a newly registered MCP or plugin tool — stays blocked by default; the dispatch tools (`delegate`, `orchestrate`, `send_message`, `todo_write`, `compress`) are rows like any other; "Reset to defaults" returns to the 12 built-in allowed tools. A checkbox change rebuilds the main agent's tool table at once, so an already-open session sees it on its next message, with no new session and no switch off/on.

![Dispatch mode panel](docs/images/dispatch-panel.png)

*The dispatch mode panel: the enable switch, the main agent's and the subagents' models and reasoning effort, and the subagent patrol interval (default 600 s, range 10–86400); the Allowed Tools whitelist sits on the right.*

## Configuration

Every field is volatile: the host stores it and the plugin re-reads it on each use, so changing the configuration needs no restart.

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch for dispatch mode. When off it revokes the hiding; the guard stays installed but lets calls through. |
| `allowedTools` | 12 built-ins | Whitelist-driven: the main agent may use only the tools listed here; every other host, MCP, or plugin tool is hidden and disabled automatically. Check a row in the panel's Allowed Tools column to allow it, uncheck to block it; effective on the next message. An explicit list replaces the default as a whole and "Reset to defaults" returns to the 12 built-ins. |
| `workerProvider` | `""` | Subagent provider; empty means unconfigured. |
| `workerModel` | `""` | Subagent model; empty means unconfigured. |
| `workerReasoningEffort` | `""` | Subagent reasoning effort; empty means it is not passed and the model resolves the default. |
| `superviseEnabled` | `true` | Master switch for supervision. |
| `superviseIntervalSeconds` | `600` | Supervision interval in seconds, an integer 10–86400. |
| `superviseMaxNoticesPerChild` | `3` | Most notices per subagent, an integer 0–20. `0` turns supervision off; the running child stays registered, so raising the number or switching unlimited on resumes it at once. |
| `superviseUnlimited` | `false` | Unlimited supervision. When on, the `superviseMaxNoticesPerChild` cap (including `0`) is ignored: as long as the child has not stopped, delivered or ended, it is reported every interval, and the notice header drops the denominator (`第 N 次`). |
| `superviseNotifyOnNoProgress` | `false` | Whether to also notify when the log has no new activity (unlimited supervision always reports). |
| `toolCatalog` | `[]` | The live tool catalog the plugin publishes: every tool name the host currently offers — global tools plus the tools each live root agent's scope registers — which is how the panel lists tools beyond the 12 built-in allowed tools (MCP servers, other plugins, and scope-local tools included). Written by the plugin; do not edit it by hand. Being listed here means "visible", not "allowed". |

The main agent's default route is not part of this configuration: it lives in the host's `agent-default-model` (`provider` / `model` / `reasoningEffort`), is written by the same panel, and is read when a new agent is created.

## Usage

### delegate: one self-contained dynamic task

It takes `prompt` (the complete task, required), `description` (a 3–5 word display name, required), `writeScope` (required — the files or directories this worker may write, see below), and `cwd` (optional). The worker cannot see the main agent's conversation, so the prompt has to carry all the context itself:

```json
{
  "description": "move config loading",
  "writeScope": ["src/config.ts", "src/settings.ts"],
  "prompt": "Goal: move config loading from config.ts to settings.ts without changing behaviour\nFiles you may change: src/config.ts, src/settings.ts\nAcceptance: node --test test/settings.test.mjs\nOn failure: do not change the public API; write the reason into the conclusion and stop"
}
```

Every worker gets the same fixed instruction at the start of its prompt: `用中文回复。` (answer in Simplified Chinese), followed by the requirement to end the turn with the final summary in the reply and not to call `send_message` to report completion, because the parent receives the closing message automatically. For several independent tasks, call `delegate` once each in the same message and they all start at once.

### orchestrate: batch dispatch

"One set of items × one fixed set of stages" goes to `orchestrate`, and one call collects every result; use `delegate` instead when you need to branch on intermediate results, loop, or reshape the dispatch while reading results. With a single stage, every item gets its own worker:

```json
{
  "items": ["alpha", "beta", "gamma"],
  "stages": [
    { "name": "summarize", "prompt": "Summarize this item in one sentence." }
  ],
  "maxConcurrency": 2,
  "writeScope": ["out/summaries/"]
}
```

With several stages, items advance one by one and a later stage automatically receives the earlier output of the same item. `items` is 1–64 and `stages` is 1–8; the call returns `{ kind: "orchestration", agentsStarted, results, errors }`, with `results` in input order and `null` for a failed item.

### writeScope: one writer per file, enforced before dispatch

Both dispatch tools require a **top-level `writeScope: string[]`**. It is the structural contract that replaces the old prompt-only promise of "never let two subagents edit the same file":

- **Shapes**: an exact file (`src/index.js`), a directory (`dir/` or `dir/**`, both meaning the whole subtree), or the global root (`*`).
- **Normalization**: paths are resolved lexically against the dispatch `cwd` (no symlink resolution) and de-duplicated **case-insensitively on Windows**.
- **Refusals**: omitting the field fails with `write-scope-missing`; an empty array, wildcard abuse or an illegal path fails with `write-scope-invalid`.
- **Single-writer leases**: `delegate` holds one lease per child for the child's whole lifetime; `orchestrate` holds one lease for the whole batch, atomically. Both share one process-wide lease table, so a `delegate` worker and an `orchestrate` batch can refuse each other.
- **Blocked before anything starts**: overlapping scopes raise a structured `write-scope-conflict` (conflicting path, holder, `expiresAt`) **before any worker is launched**, with `agentsStarted: 0`.
- **Always released**: on `subagent/end`, on `agent/disposed`, in `orchestrate`'s `finally` (normal completion, thrown error and abort alike) and on plugin dispose; a **30-minute TTL** is the backstop against a lease leaked by a crashed host.

`writeScope` is a dispatcher-side mutual-exclusion contract, not an OS-level file sandbox: it guarantees no two overlapping dispatches run at once, not that a worker stays inside its declared scope.

`delegate` is asynchronous: there is no progress callback, and the main agent has no tool to stop a worker — stopping one takes a host-side action.

## License

MIT © 2026 SShiRkiT
