# 主循环每次 API 请求实际带的 effort：可观测途径与 Code Mode 读法

调研日期：2026-11-18。用途：mod 在 `turn.step` 里用 `next({ ...e, effort })` 改写主循环请求的档位后，需要确定每个 API 请求实际带的是哪一档，尤其是 Code Mode 会话。本文只用一手来源：code.claude.com 与 platform.claude.com 文档、官方 CHANGELOG、2.1.327 生成的类型声明。不把 token 数当证据。未运行 `claude`，未读取任何转录内容。

标注约定：
- **官方原文**：逐字引用的英文原文，附 URL 或文件行号。
- **推断**：由官方原文推出，原文没有直接写。
- **未文档化**：查过的来源都没有写，括注查了哪里。

类型声明（下文记作 TYPES）：/private/tmp/claude-501/-Users-alexnear-Documents-claude-mods--claude-worktrees-dp-rewrite/0a10ce6b-598d-4504-9bf2-d09b7c6e3dc9/scratchpad/dp-probe4/.claude-plugin/types/claude-code/index.d.ts 。下文的行号都指这个文件。

CHANGELOG 记作 CHANGELOG，行号指 https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md 的原文行。

---

## 结论

1. **文档化的逐请求读数只有 OTel。** 每个 API 请求一条 `claude_code.api_request` 事件，带 `effort` 属性（**官方原文**，monitoring-usage.md，见 A.1）。`OTEL_LOG_RAW_API_BODIES` 可给出请求体。两者都要求 OTel 开启，而 OTel 开启时 Code Mode 不启动（**官方原文**，code-mode.md，见 D）。所以这两条在 Code Mode 里不可用。

2. **Code Mode 里有一条文档化的线上读法，待实测。** mods 的 `http.fetch` 钩子会收到 Claude Code 自己的请求，文档写的是「such as a model request」（**官方原文**，mods/reference.md「Fields on Claude Code's own `http.fetch` requests」；TYPES 4133–4140）。`e.init.body` 是请求体（TYPES 6219 起）。Messages API 把档位放在 `output_config.effort`（**官方原文**，effort.md），所以请求体里应能看到发出去的档位。请求体里确有该字段，是**推断**，文档没有逐字段列出请求体。该钩子需要 Claude Code v2.1.321 或更高（**官方原文**）。
   - 前提：内置守卫 `sec-default@builtin` 没有加载。守卫在机器有 managed settings 或 `managed-mcp.json`，或会话用 Team/Enterprise 的 `/login` 凭据时加载。守卫加载后，只有组织的 mod 能收到引擎请求（**官方原文**，mods/admin.md「Know what happens by default」；TYPES 4136–4140）。
   - 与 Code Mode 兼容：仓库 CLAUDE.md「编写约束」里的 Code Mode 禁用事件清单没有 `http.fetch`。这是**推断**，需在 Code Mode 会话里实测。

3. **mod 自己的 `turn.step` 输入不是引擎实际发出的档位。** `TurnStepInput.effort` 的注释写明，改写之后仍会被上限压低（`maxEffortLevel`、组织上限、模型不支持等）（**官方原文**，TYPES 17467–17476）。`TurnStepResult` 里没有 `effort` 字段（TYPES 17512 起搜不到）。

4. **下面几条都不是逐请求的读数。** `$.agent.list()` 的 `lastRequest.effort` 只覆盖子代理（**官方类型注释**，TYPES 190–193、310–313）。`$.model.fork` 的 `effort` 是 fork 自己那个请求的档位（**官方类型注释**，TYPES 7339–7341）。statusline 与 hooks 的 `effort.level` 是会话设置或当前轮设置（**官方原文**）。

5. **转录里的 `api-request` 系列行没有文档。** 官方只说转录的一行可能是「a record of a request Claude Code sent the model」，并声明格式是内部的，会随版本变化（**官方原文**，sessions.md）。`api-request`、`api-request-blob`、`api-request-shape`、`perTurnEffort` 在文档、CHANGELOG 和 TYPES 里都搜不到（**未文档化**）。它们不能作为正式证据。

6. **两条待测线索。** (a) `telemetry.log` 钩子带 `{ to: 'collector' }` 过滤时，能看到引擎的 collector 记录，记录名为 `claude_code.<event>`（**官方类型注释**，TYPES 5162、3700–3706、15790 附近）。文档没写 `api_request` 是否在其中，也没写没有 OTel 导出时是否产生这些记录（**未文档化**）。(b) 用户假设「mod 不能钩 anthropic 遥测流」只对了一半：mod 不能排队一方行（那些由内置插件排队），但能钩 `telemetry.log` 和 `http.fetch`。

7. **横幅的第二句文档里没有。** 横幅中的「Code Mode doesn't yet send it an event for each tool call」在文档中找不到（**未文档化**）。文档只说 `OpenTelemetry is on` 时 Code Mode 不启动（见 D）。

### 按准确度排序的读数

| 顺序 | 途径 | 读的是什么 | 文档状态 | Code Mode 中可用 |
|---|---|---|---|---|
| 1 | `http.fetch` 钩子读引擎请求体 | 线上发出的请求体，每次发送一条 | 事件与字段有文档；请求体含 `output_config.effort` 是推断 | 推断可用，待实测 |
| 2 | OTel `claude_code.api_request` 的 `effort` | 引擎为该请求算出的档位（「applied to the request」） | 官方原文 | 不可用（OTel 开启即不启动） |
| 3 | OTel `OTEL_LOG_RAW_API_BODIES` 的请求体 | 发出的 Messages API 请求参数 | 官方原文；请求体字段未逐项列出 | 不可用 |
| 4 | `telemetry.log`（`to: 'collector'`）里的 `claude_code.api_request` | 同 OTel 事件，若会产生 | 钩子与记录名有文档；是否含 api_request 未文档化 | 未知，待实测 |
| 5 | mod 自己的 `turn.step` 记账 | mod 要求的档位，不含引擎上限 | 推断 | 可用 |
| 6 | hooks 的 `effort.level` 与 `$CLAUDE_EFFORT`；statusline 的 `effort.level` | 会话设置，或当前轮设置（含 skill、subagent、ultrathink） | 官方原文；不反映 mod 改写 | 可用（hooks 在 Code Mode 中照常运行） |
| 7 | 转录 `.jsonl` 的 `api-request` 行 | 未文档化的内部记录 | 未文档化 | 推断可写入 |
| 8 | `$.agent.list()` 的 `lastRequest.effort`；`$.model.fork` 的 `effort` | 子代理的最后一个请求；fork 自己的请求 | 官方类型注释 | 可用，但不覆盖主循环 |

### 给主会话的实测要点

- Code Mode 会话（`CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1`，不开 OTel）里，mod 同时挂 `turn.step`（改写 effort）和 `http.fetch`（只看 `next.origin.plugin === "engine"` 且 url 指向 Messages 端点的请求）。记下请求体里的 `output_config.effort`，并与 `turn.step` 写入的值对照。
- 设一个会压低档位的上限（`maxEffortLevel`，或 `CLAUDE_CODE_EFFORT_LEVEL` 作为上限），看请求体的值是否与写入值不同。
- 在不开 Code Mode 的 OTel 会话里，对同一配置对照 `api_request.effort`，确认两条路得到的档位一致。
- 用 `/plugin` 查看是否有 `cc-plugin-sec-default` 在加载（守卫是否加载，见 admin.md）。
- 在没有 OTel 配置的 Code Mode 会话里，看 `telemetry.log`（`to: 'collector'`）是否会收到 `claude_code.api_request`。
- 版本至少 2.1.321。

---

## A. 所有文档化的观测途径

### A.1 OpenTelemetry（monitoring-usage.md）

- `claude_code.api_request` 事件。**官方原文**：「Logged for each API request to Claude.」其 `effort` 属性：「`effort`: [Effort level](https://code.claude.com/docs/en/model-config.md#adjust-effort-level) applied to the request: `"low"`, `"medium"`, `"high"`, `"xhigh"`, or `"max"`. Absent when Claude Code sends no effort level, for example on a model that doesn't support effort.」
  - 报的是每个请求上的档位（「applied to the request」）。文档没写它是否反映 mod 的改写（**未文档化**）。CHANGELOG 2.1.312（L1629）写：「Fixed the spinner, OpenTelemetry `effort` values and transcripts naming a newly picked effort level during a task before the model applied it; they now show the level in force」（**官方原文**）。这说明 OTel 的 effort 取的是「生效中的档位」。
- `claude_code.cost.usage` 与 `token.usage` 指标也有 `effort`，文字同上（**官方原文**，同页成本计数器段）。CHANGELOG 2.1.117（L8057）引入。
- `claude_code.llm_request` span 有同名属性（**官方原文**，Span attributes 表，「Requires Claude Code v2.1.274 or later」）。span 要求 Traces（beta）：「To enable it, set both `CLAUDE_CODE_ENABLE_TELEMETRY=1` and `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`」（**官方原文**）。
- `OTEL_LOG_RAW_API_BODIES`（**官方原文**，环境变量表）：「Emit the full Anthropic Messages API request and response JSON as `api_request_body` / `api_response_body` log events (default: disabled). Bodies include the entire conversation history.」事件的 `body`：「JSON-serialized Messages API request parameters, such as the system prompt, messages, and tools, truncated at the content limit (60 KB by default). Extended-thinking content in prior assistant turns is redacted.」请求体含 `output_config` 是**推断**（它属于 Messages API 请求参数，effort.md）。文件模式（`file:<dir>`）给出未截断的请求文件，并有 `request_body_id` 与响应配对。

### A.2 Statusline（statusline.md）

`effort.level`（**官方原文**）：「Reasoning effort level set for the session (`low`, `medium`, `high`, `xhigh`, or `max`), not one that a skill, a subagent, or `ultrathink` set. If you set a level the model doesn't support, this shows the level Claude Code ran instead. A level you change shows here even before it starts. With a level in `CLAUDE_CODE_EFFORT_LEVEL`, this shows that level. Absent when the current model does not support the effort parameter.」

- 报的是会话设置，不是逐请求。文档没有提 mod 改写（**未文档化**；推断它不反映）。

### A.3 Hooks 输入（hooks.md，公共字段表）

`effort`（**官方原文**）：「Object whose `level` is the effort level setting when the hook runs, including a skill's, subagent's, or `ultrathink` level: … Present for `PreToolUse`, `PostToolUse`, `Stop`, `SubagentStop`, and other events with a tool-use context, on models with effort. If the model doesn't support your level, `level` is the level that ran. A level you changed can show here before it starts. `$CLAUDE_EFFORT` holds the same level.」

- 比 statusline 多了 skill、subagent、ultrathink 的当前轮档位，仍不是逐请求。mod 改写：**未文档化**。
- hooks 在 Code Mode 中照常运行（**官方原文**，code-mode.md：「each tool call in it goes through your `deny` and `ask` permission rules and your `PreToolUse` hooks under the tool's usual name, such as `Bash`.」）。

### A.4 环境变量与 `/effort`

- `CLAUDE_CODE_EFFORT_LEVEL`（**官方原文**，env-vars.md）：「Set the effort level for supported models. Values: `low`, `medium`, `high`, `xhigh`, or `max`. … Takes precedence over `--effort`, `/effort`, and the `modelSettings` and `effortLevel` settings.」这是输入，不是读数。
- `/effort status`（**官方原文**，model-config.md）：`Effort level: auto` 表示「no effort level is sent」，`Effort level: auto (currently <level>)` 表示「a level is still sent」。它是会话级。

### A.5 SDK、headless、`/usage`、`/cost`、`/status`、调试日志

- Agent SDK 的 `effort` 选项（**官方原文**，agent-sdk/typescript.md）：「Controls how much effort Claude puts into its response. Works with adaptive thinking to guide thinking depth.」是会话输入。
- `claude -p --output-format json` 或 `stream-json`（**官方原文**，sessions.md）：「to capture the result, session ID, usage, and cost of a non-interactive run as structured JSON.」文档没有列 effort 字段（headless.md 里 effort 只出现在 `/effort` 作参数的说明中）。
- `/usage`、`/cost`（costs.md）：只讲会话 token 与费用，没有 effort（**未文档化**为读数）。
- `--debug`、`--debug-file`、`DEBUG`（cli-reference.md、env-vars.md）：**官方原文**：「Debug logs are written to `~/.claude/debug/<session-id>.txt`, or to the path set by `CLAUDE_CODE_DEBUG_LOGS_DIR`.」文档没说调试日志会记录请求参数（**未文档化**）。

### A.6 转录

见 B。

### A.7 mods API 中的候选读数

- `turn.step` 的 `e.effort`：该步发出前的值（输入）。见 C。
- `http.fetch` 的引擎请求：见 C，以及结论 2。
- `telemetry.log` 与 `telemetry.mark`（mods/reference.md「Telemetry」）：**官方原文**：「Telemetry events fire for the usage records Claude Code logs」，「In a mod you install, give a telemetry hook the filter `{ to: 'collector' }`」。见 C。

### A.8 feature-availability

「These work on every provider」列表中有「OpenTelemetry metrics」（**官方原文**，feature-availability.md）。这说明指标在各供应商上可用，不说明 Code Mode 可用。

---

## B. 转录行是否有文档

- **官方原文**（sessions.md「Where transcripts are stored」）：「Each line is a JSON object: a message, a tool use or result, a record of a request Claude Code sent the model, or a metadata entry. The entry format is internal to Claude Code and changes between versions, so scripts that parse these files directly can break on any release. To build on session data, use `/export` or the script interfaces instead.」
  - 结论：有「请求记录」这一类行，但行的种类与字段不是公开接口。`api-request`、`api-request-blob`、`api-request-shape` 没有文档（**未文档化**）。
- **CHANGELOG 2.1.300**（L2229，**官方原文**）：「Changed local session transcripts to also record each API request's system prompt, tools and parameters, so a transcript you choose to share can reproduce a request exactly」。这是请求记录的来源。文档没说它由什么开关控制：是否需要 `--debug`、是否默认开启，都没写（**未文档化**）。
- **CHANGELOG 2.1.312**（L1629）说 transcripts 里的 effort 是「生效中的档位」（见 A.1）。这说明 transcript 带 effort，但没说是哪个字段、哪种行。
- 反馈功能不是转录格式：**CHANGELOG 2.1.273**（L4430）「Changed `/bug` and `/feedback` reports to include only model-behavior params (model, system prompt, tools) from the last API request」；**CHANGELOG 2.1.224**（L5895）「… uploads the last request's model settings」。
- 搜索结果：`api-request`、`perTurnEffort`、`per_turn_effort`、`api_request`（作为转录行名）在文档、CHANGELOG、TYPES 中都没有（**未文档化**）。`CLAUDE_CODE_MODEL_CAPABILITIES=per_turn_effort` 只在 TYPES 7487 出现，文档中没有。`output_config` 在 Claude Code 文档中只出现在 API 引用里（env-vars.md 的 `CLAUDE_CODE_DISABLE_STRUCTURED_OUTPUTS` 一行除外）。
- 社区线索（非官方，只作背景）：GitHub issue #49400「Docs: publish JSONL session schema」以 not planned 关闭，议题正是转录格式未公开文档。

**结论**：转录里的 `api-request` 行不是文档化接口，不宜作为正式证据。在 Code Mode 里，`http.fetch` 读到的请求体比转录更直接。

---

## C. mods API 类型里的相关注释

以下引用来自 TYPES（2.1.327 生成），注释的换行已合并。

**`TurnStepInput.effort`，TYPES 17467–17476（全文）**：
> How hard the request asks the model to think: the level its loop, `CLAUDE_CODE_EFFORT_LEVEL`, turn or session set, or the model's default. Absent on a model without effort, or if that variable is `unset` or `auto` with no `maxEffortLevel` cap. A rewrite lasts one step. On a model that takes effort per message, a level on tool results alone is not sent if another is in force, and one on a step with input stays for later tool steps whose `effort` is a level. A number goes out at once on internal builds only, unless that cap makes it a level; public ones refuse a hook's.

**`turn.step` 事件注释，TYPES 5351–5358**：
> Fires when the engine is about to send a model request of a turn, main's or a subagent's (`e.agentId`); `next(e)` resolves to the whole response. `next({ ...e, model })` or `effort` sends another; the turn, the index and the message count are pinned. An answer without `next` sends no request. It streams (StreamNext): the hook's budget counts its own code alone.

**`TurnStepInput` 注释，TYPES 17443–17449（节选）**：
> The input of `turn.step`: one model request inside a turn, at the moment the engine is about to send it; the bottom of the chain sends it. The transcript is not on it: `messageCount` says how many messages the request carries, and `$.session.messages()` reads them … A hook rewrites `model` or `effort` going down; the rest is pinned.

**`TurnStepResult`**：没有 `effort`（TYPES 17512 起）。

**`AgentInfo`，TYPES 190–193、284–290、310–313**：
> One agent loop of this session as `$.agent.list()` returns it: a subagent or a teammate.

- `effort`：「The effort set for it (its definition's or the call's), a level or a number, as written; absent when it takes the session's. What a request carries may be less: a model caps it, or takes none (`lastRequest`).」
- `lastRequest`：「The last request of its loop that the API began to answer; absent before the first, and for a teammate in a pane of its own.」
- 主循环不在列表里。`$.agent.list()` 的注释（TYPES 3799–3807）：「Returns the session's agents so far, subagents and teammates: the ones the model spawned and the ones plugins did alike.」

**`AgentRequest`，TYPES 446–468**：
> One request of an agent's loop (a `turn.step`'s) as it went out, past caps, fallbacks and a hook's rewrite.

- `effort`：「The effort it carried; absent where none was sent. The step's `effort` as the hooks left it, unless a limit lowered it or another level was in force (TurnStepInput).」
- 子代理的读数已包含上限的影响。主循环没有对应的读数（**推断**：规则相同，但主循环没有公开读数）。

**`$.model.fork` 与 `ModelForkRequest.effort`，TYPES 7455–7496**：
- 注释：「Default: the level the session runs at, which is the main thread's and no ceiling: a fork may ask for more.」
- 结果的 `effort`（TYPES 7339–7341）：「On a fork, the effort its last response was asked for: what the request's `effort` came to under its limits, or the session's own level when it named none.」
- per-message 的备注（TYPES 7474–7490，节选）：「The person can have the session's model take effort per message, with `CLAUDE_CODE_MODEL_CAPABILITIES=per_turn_effort` in their shell or in the `env` of their user or managed settings: first-party API only, and until the API refuses it.」
- 文档中没有 `CLAUDE_CODE_MODEL_CAPABILITIES`（全文搜索为空，**未文档化**）。

**Hook 输入的 `effort`，TYPES 1136–1141**：
> Reasoning effort applied to the current turn. Same shape as StatusLineCommandInput.effort. Present for hooks that fire within a tool-use context … absent for session-lifecycle hooks and models without effort support.

**`$.session`**：
- `$.session.model()`，TYPES 3255–3256：「Returns the main loop's model, as `/model` shows it.」只有模型，没有档位。
- `$.session.messages({ as: "api" })`，TYPES 915–934：「One message of the conversation in Messages API form, as `$.session.messages({ as: "api" })` returns it.」注释还写：「The messages are the ones the next request is built from, after the engine's normalization」。`ApiMessage` 只有 `role` 与 `content`，注释写明「In no message: the system prompt, the tool list, and what one send adds for its model (cache marks, reminders promoted to system turns).」因此它不含 `output_config`。
- `$.session.usage()`：类型中没有 `effort`。
- TYPES 中没有 `$.transcript`、`$.usage`。

**`http.fetch`（逐请求的线上读法）**：
- 事件注释，TYPES 4133–4140：
> Every model request the engine sends raises this event too, with `next.origin.plugin` "engine", once per send: after any signing (a signed request a hook rewrites no longer verifies), above compression (see `compress`). A hook rewrites the url, method, headers, Authorization included, and body, answers `{ value }` or refuses with `{ deny }`, which the caller reads as a 403. A hook that fails is skipped and the request goes on, so one used as a gate carries a `.catch`. Where the organization's guard loads, only its own mods see engine requests.
- `HttpInit.body`，TYPES 6219 起：「The request body: text, or `{ base64 }` for bytes that are not UTF-8, which only an engine request carries.」
- `HttpInit.compress`：「What the engine does to the body beneath the hooks, on an engine request alone. `body` is the plain body. Delete this and it leaves as written; set this and the engine gzips it.」
- mods/reference.md「#### Fields on Claude Code's own `http.fetch` requests」（**官方原文**）：「In an `http.fetch` hook, a `next.origin` of `{ plugin: 'engine', tier: 'core' }` marks one of Claude Code's own requests, such as a model request, not a mod's `$.http.fetch` call. Where the built-in guard is loaded, your hook doesn't get these events unless your mod counts as your organization's.」 「These events and fields require Claude Code v2.1.321 or later.」
- 注意：设置了 `compress` 时，`e.init.body` 仍是未压缩的正文（reference.md：「`e.init.compress` | Set when Claude Code compresses the body after your hook. `e.init.body` holds the uncompressed body.」）。

**`telemetry.log` 与 `telemetry.mark`**：
- 事件注释，TYPES 5155–5166：「Fires when a record is about to be logged to the destination `e.to` names: a built-in's `$.telemetry.log`, or the engine's own events. … Beneath the hooks the engine exports its own collector records.」
- `$.telemetry.log` 注释，TYPES 3693–3707：「A first-party row is queued by the built-in plugin that hooks the event, for built-ins and the engine alone. A collector record reaches the collector only when the engine raised it; any plugin may hook.」
- `TelemetryRecordEntry.event`，TYPES 15790 附近：「The record's event; it leaves named `claude_code.<event>`.」
- mods/reference.md「### Telemetry」（**官方原文**）：「Telemetry events fire for the usage records Claude Code logs」，「In a mod you install, give a telemetry hook the filter `{ to: 'collector' }`」。
- 文档与类型都没写 `api_request` 是否属于 collector 记录，也没写没有 OTel 导出时是否会产生（**未文档化**）。

---

## D. Code Mode 与 OpenTelemetry

- **官方原文**（code-mode.md「Requirements」）：「You also can't start Code Mode with some settings on, such as an API key helper, OpenTelemetry export, or `DISABLE_TELEMETRY`.」
- **官方原文**（code-mode.md「Code Mode doesn't start」表）：「`OpenTelemetry is on` | Unset `CLAUDE_CODE_ENABLE_TELEMETRY` and `ENABLE_BETA_TRACING_DETAILED` if you can work without OpenTelemetry export」。
- 横幅第二句「and Code Mode doesn't yet send it an event for each tool call」文档中没有（**未文档化**）。
- 文档中没有任何其他遥测路径在 Code Mode 中可用的说明（**未文档化**）。`DISABLE_TELEMETRY` 同样被列为阻止 Code Mode 的设置。
- 文档滞后：code-mode.md 的表格仍写「`it doesn't yet work with an installed mod` | Turn off the mod that checks tool calls」。CHANGELOG 2.1.327（L158，**官方原文**）：「Changed Code Mode to no longer refuse to start when an installed mod hooks tool calls; an administrator can still keep Code Mode off in managed settings」。本文建议的 mod 只挂 `turn.step` 与 `http.fetch`，不属于这一限制。
- 社区线索（非官方，待验证）：GitHub issue #104734（2.1.309 上报，状态 open）称交互式会话不导出 OTel，而 `-p` 导出。若属实，OTel 读数本身在交互式会话里也不可靠，需要先在 2.1.327 上验证。

---

## E. Claude API 文档

- **官方原文**（build-with-claude/effort.md，「API support」）：「**Messages API**: Set `output_config.effort` on the request. With no value, the model's default level applies.」
- 与默认值相同：「Setting `effort` to the model's default (…) produces exactly the same behavior as omitting the `effort` parameter entirely.」
- 作用范围：「The effort parameter affects **all tokens** in the response, including: … Thinking (when active)」。
- 逐消息（effort-per-message.md，beta，头 `mid-conversation-output-config-2026-07-01`）：「A per-message effort change sets a new effort level for later turns of a conversation without changing the request's top-level value, so the cached prefix still matches.」做法：在 `messages` 里加一条 `role: "system"`，`content` 为空，`output_config.effort` 为新档位。
- 生效位置：「Directly after a `user` turn with new input: Claude's reply to that turn uses the new level.」「In any other position … the new level starts at the next `user` turn with new input.」「A `user` turn that holds only `tool_result` blocks doesn't count as new input.」
- 支持的模型（页面 metadata 与正文）：Claude Fable 5.2、Mythos 5.2、Fable 5.1、Mythos 5.1、Opus 5.5、Opus 5、Sonnet 5.5、Haiku 5.5（**官方原文**）。不支持的模型报错：「With the beta header, models without per-message effort, such as Claude Fable 5, return a 400 error: `output_config.effort requires a model that supports per-turn effort; this model does not`.」
- 缓存：
  - effort.md：「Because top-level effort shapes the rendered prompt, changing it between requests can invalidate cached prefixes from earlier turns.」
  - prompt-caching.md：「Changing the `output_config.effort` value can invalidate message blocks, and on some models tool and system caches too」。
  - effort-per-message.md：「Prefer per-message effort over changing the top-level value between requests. A per-message change leaves everything before it unchanged, so the cached prefix still matches. A top-level change can invalidate all or part of the cache.」
- 响应是否回显：api/messages/create.md 中 `effort` 只出现在请求参数 `output_config` 下，字段说明为「How much effort the model should put into its response. Higher effort levels may result in more thorough analysis but take longer.」。响应对象中没有 `effort` 字段（**未文档化**为回显；页面中找不到）。
- mid-conversation-system-messages.md 同样写明：「A `role: "system"` message can also carry `output_config.effort`」（**官方原文**）。这说明请求体的 system 消息里可以出现 `output_config`。Claude Code 是否用这种形式，文档未写（**未文档化**）。

---

## F. CHANGELOG（2.1.300 起，与 effort、缓存、mod 改写相关）

逐字引用，版本与行号对应 CHANGELOG 原文。

- **2.1.300**（L2229）：「Changed local session transcripts to also record each API request's system prompt, tools and parameters, so a transcript you choose to share can reproduce a request exactly」
- **2.1.312**（L1629）：「Fixed the spinner, OpenTelemetry `effort` values and transcripts naming a newly picked effort level during a task before the model applied it; they now show the level in force」
- **2.1.312**（L1630）：「Fixed the `/model` and `/effort` cache warning saying the re-read waits for your next message; a change made while Claude is working can trigger it sooner」
- **2.1.318**（L1266）：「Added an `effort` option to a mod's `$.model.fork`, so a quick side job can run at `low` whatever effort the session uses; the result reports the effort sent」
- **2.1.317**（L1415）：「Changed subagents and teammates on a different model from the main conversation to use that model's saved effort level or its default, instead of the session's effort level」
- **2.1.316**（L1444）：「Added `CLAUDE_CODE_SUBAGENT_EFFORT` to set the effort level subagents run at when nothing else names one, instead of inheriting the session's」
- **2.1.310**（L1759）：「Fixed requests failing behind some gateways and compatible servers that reject the `effort-2025-11-24` beta value or mid-conversation system messages; Claude Code now retries without them」
- **2.1.309**（L1819）：「Fixed a mod's `turn.step` hook that names a model by alias, such as `haiku`, failing every request with a model error: the alias now resolves to its model」
- **2.1.292**（L2745）：「Added an `effort` parameter to the Agent tool, so Claude runs a sub-agent at the effort level you ask for」
- **2.1.290**（L2879）：「Fixed the effort level changing when a flagged message is retried on a fallback model that has a different level saved in settings」
- **2.1.287**（L3243）：「Changed automatic model switches after a flagged message to keep your current effort level instead of the new model's default」
- **2.1.274**（L4283）：「Added `effort` attribute to the `claude_code.llm_request` OpenTelemetry trace span, matching the `api_request` event」
- **2.1.274**（L4337）：「Improved `OTEL_LOG_RAW_API_BODIES=file:<dir>` output: a new `index.jsonl` and `request_body_id` / `message.id` event attributes link each response to its request file and transcript message」
- **2.1.260**（L5001）：「Improved `/effort` on Claude Fable 5.1 so changing effort mid-session no longer invalidates the prompt cache」
- **2.1.201**（L6511）：「Claude Sonnet 5 sessions no longer use the mid-conversation system role for harness reminders」
- **2.1.117**（L8057）：「… `cost.usage`, `token.usage`, `api_request`, and `api_error` now include an `effort` attribute when the model supports effort levels」
- **2.1.327**（L158）：「Changed Code Mode to no longer refuse to start when an installed mod hooks tool calls; an administrator can still keep Code Mode off in managed settings」

CHANGELOG 中没有直接写「mod 改写 effort 会反映在某读数中」的条目。与 mod 的 turn.step 相关的条目只有 2.1.290、2.1.309、2.1.318（**未找到**直接写 effort 改写的条目）。CHANGELOG 中也没有 `http.fetch` 引擎请求事件的条目（文档标明 v2.1.321 起）。

---

## 读过的页面

官方文档（code.claude.com，经 Spider 抓取，markdown 形式）：
- https://code.claude.com/docs/llms.txt（索引）
- https://code.claude.com/docs/en/monitoring-usage.md（全文扫读 effort、OTel、traces、raw bodies 段）
- https://code.claude.com/docs/en/code-mode.md（全文）
- https://code.claude.com/docs/en/model-config.md（effort 段、fallback、/effort status）
- https://code.claude.com/docs/en/statusline.md（available data 表）
- https://code.claude.com/docs/en/hooks.md（公共字段表 effort）
- https://code.claude.com/docs/en/env-vars.md（EFFORT、DEBUG、DEBUG_LOGS_DIR、OTel 相关）
- https://code.claude.com/docs/en/sessions.md（导出与转录位置）
- https://code.claude.com/docs/en/agent-sdk/session-storage.md（扫读）
- https://code.claude.com/docs/en/cli-reference.md（--debug、--effort）
- https://code.claude.com/docs/en/costs.md（扫读）
- https://code.claude.com/docs/en/feature-availability.md（OTel 与 Code Mode 行）
- https://code.claude.com/docs/en/debug-your-config.md、troubleshooting.md（扫读调试相关段）
- https://code.claude.com/docs/en/agent-sdk/typescript.md（effort 行；因 200K 截断，只能读到前部）
- https://code.claude.com/docs/en/agent-sdk/agent-loop.md、observability.md、cost-tracking.md、hooks.md（扫读）
- https://code.claude.com/docs/en/headless.md（扫读）
- https://code.claude.com/docs/en/settings-reference.md（effortLevel、maxEffortLevel 行；因 200K 截断，正文不完整）
- https://code.claude.com/docs/en/plugins/mods/reference.md（Telemetry、http.fetch engine 字段、turn.step 行）
- https://code.claude.com/docs/en/plugins/mods/events.md（turn.step 段）
- https://code.claude.com/docs/en/plugins/mods/api.md（$.model 段）
- https://code.claude.com/docs/en/plugins/mods/admin.md（Know what happens by default）

Claude API 文档（platform.claude.com，经 Spider 抓取）：
- https://platform.claude.com/llms.txt（索引）
- https://platform.claude.com/docs/en/build-with-claude/effort.md
- https://platform.claude.com/docs/en/build-with-claude/effort-per-message.md
- https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages.md（扫读）
- https://platform.claude.com/docs/en/build-with-claude/mid-conversation-effort-example.md（只扫了代码示例）
- https://platform.claude.com/docs/en/build-with-claude/prompt-caching.md（effort 相关行）
- https://platform.claude.com/docs/en/api/messages/create.md（effort 字段与响应对象）
- https://platform.claude.com/docs/en/models/fable-5-2/whats-new-fable-5-2.md（已抓取，未引用）

其他：
- CHANGELOG：https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md（整份下载到 scratchpad，只做 grep 与按行读取）
- 类型声明：2.1.327 生成的 index.d.ts（路径见文首）
- Exa 检索的线索（非官方，只作背景，未据此下结论）：
  - https://github.com/anthropics/claude-code/issues/49400（JSONL 格式未文档化）
  - https://github.com/anthropics/claude-code/issues/50175（已作为重复关闭）
  - https://github.com/anthropics/claude-code/issues/104734（交互式会话 OTel 导出，open）

---

## 本机实测（由主会话填写）

2026-11-18，Claude Code 2.1.327，tmux 里的交互会话，主循环 Sonnet 5.5，订阅登录，会话档位 `low`，一次性探针 mod 在 `turn.step` 里把档位改成 `xhigh`。探针不进仓库，没有记录请求体的内容，只记了档位字段。

**三种读数，逐次一致**

| 读数 | 普通会话 | Code Mode 会话 |
|---|---|---|
| `http.fetch` hook 读请求体顶层的 `output_config.effort` | 未单独跑 | 已测 |
| 会话记录文件里 `api-request` 行的 `params.output_config.effort` | 已测 | 已测 |
| OpenTelemetry `api_request` 事件的 `effort` | 已测 | 不可用：开了遥测，Code Mode 不启动 |

- `http.fetch`：主循环的请求 `next.origin.plugin` 是 `engine`，URL 含 `/v1/messages`，请求体是字符串，能解析。凭据头读到的是 `[redacted]`。挂了它，Code Mode 照常启动。
- 请求体里除了顶层的 `output_config.effort`，带输入的消息自己也带一个 `output_config.effort`（会话记录里对应 assistant 行上的 `perTurnEffort`）。主循环的请求带 `thread` 字段，多数只发新增的两条消息。
- 没开调试参数的会话，记录文件里同样有 `api-request` 行。
- 走不通的：`$.model.fork` 返回的 `effort` 是会话的档位，不反映改写（对照遥测验证过）；`telemetry.log` 不带 `to` 的 hook 会让整个模块加载失败，带 `{ to: 'collector' }` 的没有测。

**结果（线上请求体的读数）**

| 情形 | 之后各次请求的档位 |
|---|---|
| 不加说明，只在 `turn.step` 里改 | 仍是 `low`，没有发出 |
| 说明加在 `Poll` 的结果行上 | 下一次请求起 `xhigh`，保持到这一轮结束 |
| 说明加在 `REPL` 的 `(dispatched #N)` 行上 | 同上（用会话记录读的） |
| 结果在 `delivery` 行里到达，不加说明 | 仍是 `low`（用会话记录读的） |
| 在 `delivery` 行里加文字（新加一块，或接在原文后面） | 文字没有存下，档位仍是 `low`（用会话记录读的） |
| 普通会话，说明加在 `Bash` 的结果行上 | 下一次请求起 `xhigh`，保持到这一轮结束（遥测和会话记录） |

- 从 `high` 改到 `low` 同样：加了说明才发出。
- 换档前后每次请求读到的缓存量连续增长，没有重写整段对话。
- 同一会话里的旁路请求（标题、提示建议、settings hook 的 prompt）不带 `thread`，顶层档位是会话的档位，不随改写变。

**没有回答的**

档位发出去之后模型的做法有没有变，这里没有测。单步的输出量不能当证据：一次对照里，请求确认是 `xhigh` 之后，每步的输出量仍接近 `low` 的基线。要用任务结果来验。
