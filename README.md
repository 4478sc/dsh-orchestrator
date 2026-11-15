Start from 28th October :
<div align="center">
**DSH Orchestrator**
</div>
<div align="center">

**强模型主脑规划 + 便宜模型统一打工 —— DeepSeek Harness 的「硬隔离调度模式」插件**

[![version](https://img.shields.io/badge/version-0.8.0-4176E6?style=flat-square)](https://github.com/SShiRkiT/dsh-orchestrator)
[![dsh-plugin](https://img.shields.io/badge/DeepSeek%20Harness-dsh--plugin-4176E6?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)
[![platform](https://img.shields.io/badge/platform-Web%20GUI%20%7C%20Desktop-5c6bc0?style=flat-square)](https://github.com/SShiRkiT/dsh-orchestrator)
[![node](https://img.shields.io/badge/node-%3E%3D22-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![module](https://img.shields.io/badge/module-ESM-F7DF1E?style=flat-square&logo=javascript&logoColor=black)](package.json)
[![license](https://img.shields.io/badge/license-MIT-2ea44f?style=flat-square)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/SShiRkiT/dsh-orchestrator?style=flat-square&logo=github)](https://github.com/SShiRkiT/dsh-orchestrator/stargazers)

**简体中文** | [English](README.en.md) · [核心差异](#为什么有了原生-subagent-和-agent-team还需要这个插件) · [核心特性](#核心特性) · [安装](#安装) · [配置说明](#配置说明)

</div>

---

## 为什么有了原生 `subagent` 和 `Agent Team`，还需要这个插件？

DSH 客户端自带了 `subagent` / `workflow`，官方也有 `@deepseek-ai/dsh-experimental-agent-team-profile`（Agent Team），但它们在实际高强度开发中仍有三个痛点——而这正是 **DSH Orchestrator** 独有的设计核心：

| 痛点场景 | 原生 `subagent` / 官方 `Agent Team` | DSH Orchestrator（本插件独有） |
| --- | --- | --- |
| **如何省钱配模型？**<br>*(最核心差异)* | **无独立子代理面板**：子代理要么默认继承昂贵的主模型，要么靠主模型每次调用时自己传参选模型（容易忘传或乱选，改默认模型还得改静态配置） | **双路由独立面板 + 强制锁定便宜模型**：在 UI 面板直接把 Main Agent 设为昂贵强模型，把 Subagent 统一锁死为廉价快模型（两处都填你自己宿主提供的路由，占位写法 `<your-main-provider>/<your-main-model>`、`<your-worker-provider>/<your-worker-model>`），改完下一次委派立即生效 |
| **主代理总忍不住自己动手？** | **靠自觉（软提示词）**：主代理 / Team Lead 手里依然握有 `read`、`edit`、`bash` 等全套工具，聊几轮就经常脱轨亲自去读文件、跑命令，瞬间撑爆主上下文 | **白名单式驱动（Whitelist-Driven Hard Gate）**：主代理默认仅放行 12 项规划与委派核心工具（`allowedTools`），其余一切宿主读写/终端工具及未来新增的 MCP/第三方插件工具一律自动隐藏并在执行层强制拦截（连 `run_code` 嵌套偷调也拦），**逼迫 Main Agent 100% 只做规划与验收，Subagent 100% 只干苦力活** |
| **便宜模型干活卡死/跑偏怎么办？** | **运行期黑盒**：派出后只能干等结束或超时，或者靠 `wait_agent` 阻塞轮询 | **零 Token 后台巡检唤醒**：后台定时静默扫描子代理事件日志（不调模型、零 Token 消耗），超时或卡壳时自动汇总摘要唤醒主代理，由强模型发消息精准纠偏 |
| **大批量同构任务怎么跑？** | 原生 `workflow` 让模型手写任意 JS 脚本，容易失控且模型路由不统一 | **声明式 `orchestrate` 流水线**：`items × stages` 结构化扇出与多阶段流水线，单项失败隔离、支持 JSON Schema 强校验，全部 Worker 强制走便宜的子代理路由 |

---

## 核心特性

### 1. 强模型当 Main Agent，便宜模型当 Subagent（独立面板、即时生效）

在输入框下方的**「调度模式」专属面板**中，主代理与子代理的模型路由完全解耦：
- **主代理（Main Agent）**：配置为你最强的旗舰模型（用宿主面板里实际存在的 provider / model，下文以 `<your-main-provider>/<your-main-model>` 占位），专门负责需求澄清、任务切分、途中纠偏与最终结果验收。
- **子代理（Subagent）**：配置为能力稍弱但极其便宜、高吞吐的模型（用你宿主实际提供的路由，占位为 `<your-worker-provider>/<your-worker-model>`），**所有通过 `delegate` 和 `orchestrate` 派出的 Worker 强制共用这条便宜路由**（除非用户在当前消息里明确点名要求临时换模型）。
- **防烧钱保护**：如果未配置子代理模型，派发时会直接报错拦截，**绝不静默回退去烧昂贵的主代理模型**。

![调度模式面板](docs/images/dispatch-panel.png)

*调度模式面板：左侧独立配置主代理与子代理各自的模型、思考强度及巡检间隔（截图里的路由只是示例，请填自己宿主提供的 provider / model）；右侧 Allowed Tools（白名单式驱动）实时拉取宿主全部工具（含 MCP 与其他插件工具），勾选即放行给主代理、未勾选（含新装插件工具）默认自动禁用，无需重启，下一条消息立即对当前会话生效。*

### 2. 主代理「规划与验收」、子代理「纯粹 Work」的白名单式硬性闸门

不同于靠 Prompt 劝主模型“多用子代理”，本插件在 DSH 的工具声明出口（`tools.definitions`）与执行层（`tools.guard`）安装了双重守卫，且采用**白名单式驱动**：声明层实时裁剪模型可见的工具表（全局工具与 `ops_*` 等 scope 内工具一视同仁），执行层再兜底拒绝任何漏网调用；两层都按请求/按调用实时读取配置，不产生 `tools.restrict` 事件风暴，因此不会触发官方工具遮挡的抖动与 Prompt Cache 失效。
- **主代理被彻底收缴执行工具**：`DEFAULT_ALLOWED_TOOLS` 默认只放行 12 项规划、委派与会话只读工具——`delegate`、`orchestrate`、`send_message`、`interrupt_agent`、`todo_write`、`ask_user_question`、`compress` 与 5 项只读会话日志工具。所有文件读写（`read` / `edit` / `write` / `apply_patch`）、搜索（`grep` / `glob`）、终端（`bash` / `pwsh`）、网页抓取、原生 `subagent` / `workflow`，以及未来新增的任何 MCP / 第三方插件工具，一律自动隐藏并在执行层强制拦截（连 `run_code` 嵌套偷调也拦）。需要额外放行时，在面板右侧 Allowed Tools 勾选即可。
- **子代理独享完整工具链**：被派出的 Worker 不受闸门限制，在各自独立的上下文中读写文件、跑测试、看报错，完工后只把干净的结论交回主代理验收。
- **一键随时切换**：需要主代理临时亲自操作时，关掉面板上的「启用调度模式」开关即可立刻恢复主代理的全部工具，无需重开会话。

### 3. 零 Token 后台巡检与强模型动态纠偏

便宜模型充当 Subagent 时，偶尔会在复杂的 shell 转义或报错上打转。插件内置了纯日志驱动的后台巡检器：
- **零额外 Token 消耗**：后台定时器直接读取运行中 Worker 的会话事件日志（不调用任何 LLM），按设定的巡检间隔（默认 600 秒）汇总它的运行时长、轮次、新增工具调用与最后输出，合并成一条通知唤醒主代理。
- **强模型一眼把关**：主代理收到巡检摘要后，只需极少 Token 即可做出决策：
  - **A) 进展正常**：回复一行 `巡检：正常` 结束回合，让子代理继续跑；
  - **B) 途中纠偏**：调用 `send_message` 直接向运行中的子代理注入修正指令（指明正确写法或跳过卡点）；
  - **C) 及时止损**：调用 `interrupt_agent` 中断失控的子代理（若后续再用 `send_message` 重新唤醒它，巡检会自动重新接管并重置通知计数）。

![巡检通知与纠偏示例](docs/images/patrol-notice.png)

*巡检通知与纠偏实录：便宜的子代理卡在了 shell 引号和反斜杠转义上，巡检机制按间隔唤醒主代理后，主代理通过 `send_message` 直接给出正确写法完成纠偏。*

### 4. 专为调度模式定制的 `delegate` 与 `orchestrate`

- **`delegate`（按需异步单派 / 并行扇出）**：
  用于派发自包含的独立任务（目标 + 允许修改的文件 + 验收命令 + 失败兜底）。同一回合多次调用即可同时启动多个 Worker 并行施工；插件会为每个子代理统一注入简体中文回复指令，并要求它在收尾时直接输出最终总结、禁止调用 `send_message` 向父代理汇报（收尾消息会自动送达主代理）。
  **`writeScope`（必填，`string[]`）**：声明本次派发允许修改的文件或目录，支持精确文件（`src/index.js`）、目录（`dir/` 或 `dir/**`）与全局根（`*`）。相对路径按 `cwd` 词法归一化，Windows 下大小写不敏感判重；省略报 `write-scope-missing`，空数组 / 非法路径报 `write-scope-invalid`。
- **`orchestrate`（声明式批量流水线）**：
  用于处理「一组条目（`items`，1–64）× 固定多阶段步骤（`stages`，1–8）」的批量任务，通过 `maxConcurrency`（1–16，默认 4）控制并发。支持单阶段并行扇出与多阶段**逐条目无屏障流水线**（先做完阶段 1 的条目立刻进入阶段 2，不用傻等慢条目），支持阶段级 JSON Schema 强校验与单项失败隔离。
  **`writeScope`（必填，`string[]`）**：整批共用一条顶层声明，按整批**原子持有**写作用域；归一化后的作用域会自动注入每个阶段的 Prompt 作为边界提示。
- **单写者互斥（派发前拦截）**：`delegate` 按子代理持锁、`orchestrate` 按整批持锁，两者共享同一张进程级租约表并跨工具求交。一旦作用域相交，插件会在**启动任何子代理之前**直接抛出 `write-scope-conflict`（附冲突路径、持有者与到期时间，`agentsStarted: 0`），杜绝多个 Worker 同时覆写同一文件。租约在 `subagent/end`、`agent/disposed`、`orchestrate` 的 `finally`（含异常与 abort）以及插件卸载时幂等释放，另有 30 分钟 TTL 兜底防泄漏。

---

## 环境要求

| 项目 | 要求 |
| --- | --- |
| **宿主环境** | DeepSeek Harness Desktop / Web GUI |
| **DSH 包版本** | `0.2.1-rc.3` / `0.2.2-rc.3`（兼容层按宿主实际 API 选择 spec 形态；0.2.0 走旧回退，详见下文「宿主兼容与升级注意」） |
| **Node.js** | `>= 22`（内置于 DSH Desktop 运行时） |
| **插件形态** | Cordis 后端服务补丁（`cordis.patch.yml`）+ Web GUI 客户端扩展（`lib/client.js`） |
| **界面语言** | 中 / 英双语自适应（`zh-CN` / `en-US`） |

---

## 安装

在 DSH 插件页选择「从 GitHub 添加」，下列三种写法都接受，直接填入输入框即可（推荐第一种，最不容易被客户端误判）：

```text
https://github.com/SShiRkiT/dsh-orchestrator
github:SShiRkiT/dsh-orchestrator#main
SShiRkiT/dsh-orchestrator#main
```

```bash
# CLI 等价安装
dsh plugin --profile desktop add https://github.com/SShiRkiT/dsh-orchestrator
```

> 装完后请**完全退出并重新打开 DSH**（客户端插件在启动时组合，不支持热更新）。升级时请先在插件页**卸载旧版**再重新添加本仓库，两份同时存在会争抢同一批工具声明。

---

## 宿主兼容与升级注意（DSH 0.2.1 / 0.2.2）

这里说的 `0.2.1` / `0.2.2` 是 **`@deepseek-ai/dsh` 包版本**（插件管理器校验 `peerDependencies` 用的那个号），不是 Electron / 桌面端版本，也不改插件自己的 `0.8.0`。两台机器的“关于”看起来一样，装上的 DSH 包版本仍可能不同。

插件用 `lib/start-compat.js` 与 `lib/deliver-compat.js` 对齐两代宿主的真实 API（签名均按各宿主随包发布的 `@deepseek-ai/dsh-subagent` 服务核对）：

- **启动子代理**：0.2.1 的 `startActivation(spec)` 读嵌套的 `spec.request.parent.id / maxDepth / outputSchema / cwd`（外加外层 `provider / label / signal / delivery`）；0.2.2 改读扁平的 `spec.parent.id / maxDepth / outputSchema / prompt`。插件按宿主是否还带 `Symbol.for('dsh.subagent.deliverPrompt')` 判断形态：带该符号 = 0.2.1 及更早（嵌套），没有符号但有 `prompt` = 0.2.2+（扁平）。两种形态都在**创建子代理之前**校验，所以形态选错只会明确报错，不会留下半启动的 worker。
- **重试投递**：0.2.1 用符号入口 `deliverPrompt(parent, childId, content, source, signal, 'queue')`；0.2.2 移除了该入口，改用 `prompt({ requestId, childSessionId, delivery: 'queue', content })`（按目标会话鉴权，不需要常驻父代理）；两代都有的 `sendMessage` 只作为退化的 steer 通道，并在正文里明确标注。
- **0.2.0 回退**（`startContinuable` / `start`）保留，但本轮没有在真机上重新实测。
- **工具目录的根代理枚举**：0.2.1 及更早的 `AgentRegistry` 提供 `roots()`；0.2.2 只提供 `list()`，且返回**全部存活代理**（含被委派的子代理）。插件优先用 `roots()`；宿主只有 `list()` 时，先按宿主自己的深度规则（`max(options.subagentDepth, session.header.delegationDepth)`）筛出根代理，再读各自 scope 注册的工具。因此 GUI fork（有 `parentSession` 但深度为 0）仍算主代理；子代理 scope 的私有工具不会被混进主代理面板。注册表读不到或抛错时只保留全局工具，**绝不拿“全部代理”兜底**。这条决定了 Allowed Tools 面板能不能看到 `exit_plan_mode`、`list_agents` 这类 scope 内工具。

### 验证到哪一步（引用时请按此口径）

- **已在 VM 实机验证**：宿主为 `DSH 0.2.2-rc.3` 时，动态 `delegate`、`orchestrate` 与 plan 审批都跑通，计划审批按钮由用户实测确认。那次用的是**此前的单形态 compat 构建**。
- **本次分支**：双形态补丁与工具目录的根代理枚举只做到**契约 / 回归测试**（`node --test --test-isolation=none`，381 项全过，覆盖 0.2.1 嵌套、0.2.2 扁平、无 `startActivation` 时的回退、路由 / parent / cwd / maxDepth / outputSchema / delivery / signal 透传、`receipt.result`、失败传播与投递通道，以及 `roots()` / `list()` 两种根枚举、持久化深度、GUI fork、坏注册表与目录更新事件）。**没有**在本分支构建的宿主动态运行上验证工具目录（主机 runtime 需重启后才能看到新构建，VM 的验收见 PR 说明），所以不能写成“最终 PR 构建实机全链路通过”。
- **Windows `0.2.1-rc.3`**：那台装的是**原版插件**并正常运行，这是嵌套形态的历史证据，不等同于对本分支的验证。
- 0.2.0 回退本轮未实测；本仓库的 CI 未跑绿之前，不做“CI 通过”的表述。

### 升级前后的检查清单

1. **升级前先备份 profile 补丁**：把 profile 的 `cordis.patch.yml`、`package.json`（有 `pnpm-lock.yaml` 也一并）复制到 profile 之外的日期目录；插件加载失败时先还原。
2. 升级后核对 **`enabled`**：可能被重置为关闭（主代理恢复全部工具），也可能保持开启但路由为空。
3. 核对 **worker 路由**（`workerProvider` / `workerModel` / `workerReasoningEffort`）：留空会在派发时报错，绝不会静默回退去烧主模型。
4. 核对 **`allowedTools`**：默认 12 项（`delegate`、`orchestrate`、`send_message`、`interrupt_agent`、`todo_write`、`ask_user_question`、`compress` 与 5 项只读会话工具）；用 plan 审批时再加 `exit_plan_mode`，需要列出子代理时加 `list_agents`。**profile 里显式写的列表是整体替换默认值，不是增量合并**——写短了就等于悄悄删掉默认放行的工具；面板点“重置为默认”或删掉这一项也会回到内置 12 项，两个 scope 内工具随之消失，需要重新加回。**面板里能看到某个工具名不等于它已放行**：那只是 `toolCatalog` 的只读快照，真正生效的是写进 `allowedTools` 的名字（精确匹配）。完整示例见下方与 [docs/host-compatibility.md](docs/host-compatibility.md)。
5. **不要假定面板勾选一定已持久化**：升级或插件重载后，对照面板显示与 profile 里的实际值（必要时重新勾选），再确认需要的工具真的能调起来。

> profile 的修复属于**配置**，不是仓库代码改动：插件本来就实时读取 `enabled`、`allowedTools` 与 worker 路由，因此正确做法是改 profile / 面板，而不是为了某台机器去改 `lib/`。示例配置见 [docs/host-compatibility.md](docs/host-compatibility.md)，其中的 provider / model 只是占位，请按你自己宿主提供的路由填写；插件不固定任何一条路由，也不把任何私有模型写死进仓库默认值。

### Allowed Tools：`toolCatalog` 与 `allowedTools` 的区别（能看见 ≠ 能用）

- **`toolCatalog`**：插件从宿主工具注册表读出的**只读快照**，等于“全局工具 ∪ 每个存活根代理 scope 注册的工具”（`exit_plan_mode`、`list_agents`、原生 `subagent`、`ops_*` 等都在里面）。它只负责把清单交给面板渲染，**不写 profile、也不代表放行**。宿主读不到根代理时它只含全局工具，面板因此可能少几行。
- **`allowedTools`**：执行层真正生效的**白名单**。按**完整工具名精确匹配**（不支持前缀、通配或子串）；名字没写进列表的工具一律隐藏并在执行层拒绝，即使它出现在 `toolCatalog` 里。反过来，写进列表但宿主根本没注册的名字不会报错，只是永远不生效——所以能用 `exit_plan_mode` / `list_agents` 的前提是：**宿主注册了它，并且 `allowedTools` 里有它**。
- **整体替换、不是合并**：`allowedTools` 一旦在 profile 里显式写出，就整体替换内置默认 12 项；`enabled`、worker 路由等其它字段照常保留。面板“重置为默认”、profile 重置或删掉该字段，都会回到内置 12 项。

完整写法（provider / model 是占位，必须换成你自己宿主提供的路由）：

```yaml
# <profile>/cordis.patch.yml —— 只列相关行，其它配置原样保留
- id: orchestrator
  name: dsh-orchestrator
  config:
    enabled: true
    workerProvider: <your-worker-provider>   # 例如面板里能看到的 provider id
    workerModel: <your-worker-model>         # 例如你自己选的便宜模型
    workerReasoningEffort: ""
    superviseIntervalSeconds: 600
    allowedTools:
      # —— 内置默认 12 项（显式列表必须写全，写短等于删权）——
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
      # —— 按需追加：scope 内工具必须同时被宿主注册且在此列出 ——
      - exit_plan_mode
      - list_agents
```

> 这份列表是**你这台机器的用户环境配置**，不是仓库默认值：仓库的 `DEFAULT_ALLOWED_TOOLS` 始终是 12 项，不会为了某台机器或某条私有路由而改动。

### 升级后的最小验收

审批按钮必须由人点击，agent 不能替你点。

1. **delegate**：派一个“打印当前目录”的小任务，确认返回 `subagentId` 而不是启动错误。
2. **orchestrate**：跑一个 2 条目单阶段批量，确认两项都拿到结果或单项错误（单项失败不会让整批失败）。
3. **plan 审批**：进入 plan 模式，让 agent 调 `exit_plan_mode`，确认出现批准 / 拒绝按钮，批准后离开 plan 模式；该按钮是否正常由用户实测确认，不假定一定出现。
4. **重试投递**：可选，只有子代理没留收尾消息就失败时才会触发。

常见报错的归因：`401` / 鉴权 / 模型池 / 额度错误属于**服务凭据或路由问题**，不是兼容失败；启动期的 `Cannot read properties of undefined (reading 'id')` 这类 `TypeError` 才是 spec 形态不匹配，报告时请附上宿主的 DSH 包版本。

完整 API 差异与验证边界见 [docs/host-compatibility.md](docs/host-compatibility.md)。

## 配置说明

所有配置项均为 volatile（动态热配置），在面板中修改后立即生效，无需重启 DSH：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 调度模式总开关。关闭时立即对当前会话恢复主代理全部工具。 |
| `workerProvider` / `workerModel` | `""` | 子代理默认模型路由（必填，未配置时派发直接报错，绝不静默继承主代理模型）。 |
| `workerReasoningEffort` | `""` | 子代理思考强度，留空则由所选模型自行决定默认值。 |
| `allowedTools` | 12 项内置白名单 | 白名单式驱动：主代理仅可使用列表内的工具，其余宿主/MCP/插件工具自动隐藏并禁用；面板右侧 Allowed Tools 可直接勾选放行或取消勾选禁用，下一条消息即刻生效。显式写出的列表整体替换默认值、不合并；面板“重置为默认”会回到内置 12 项。 |
| `toolCatalog` | `[]` | 插件发布的只读工具目录：宿主当前注册的全部工具名（全局工具 + 存活根代理 scope 注册的工具），面板据此列出 12 项默认白名单之外的 MCP / 插件 / scope 内工具。由插件写入，**不要手改**；它只表示“能看见”，不表示已放行。 |
| `superviseEnabled` | `true` | 子代理后台巡检总开关。 |
| `superviseIntervalSeconds` | `600` | 巡检间隔（秒），范围 10–86400，运行中修改立即生效。 |
| `superviseMaxNoticesPerChild` | `3` | 每个子代理最多发送几次巡检通知（0–20）。`0` 表示关闭巡检（运行中的子代理仍保留在注册表中，改回 >0 或打开无限巡检后立即恢复）。 |
| `superviseUnlimited` | `false` | 无限次数巡检开关。开启后忽略 `superviseMaxNoticesPerChild` 上限（含 `0`），只要子代理没有停止 / 交付 / 结束，就按间隔持续巡检，通知标题不带分母（`第 N 次`）。 |
| `superviseNotifyOnNoProgress` | `false` | 子代理日志无新活动时是否仍然发送通知（开启 `superviseUnlimited` 时等效于始终发送）。 |

> 注：主代理的默认模型保存在宿主的 `agent-default-model` 中，由同一个「调度模式」面板直接读写，对新创建的会话生效；子代理模型改动从下一次委派起立即生效。

## License

[MIT](LICENSE) © 2026 [SShiRkiT](https://github.com/SShiRkiT)
