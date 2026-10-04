# 接缝 1：用 `claude plugin test` 驱动 Dispatch Pilot 的事件面（实测笔记）

实测日期 2026-10-04。环境：Claude Code **2.1.289**（`claude --version`；`types/claude-code/index.d.ts` 第 1 行 `// Written by Claude Code 2.1.289.`），Node **v26.5.0**，tsc **7.0.2**。

> **移入仓库时的说明（#2，2026-10-04）**：本笔记原在会话 scratchpad（下文的 `NOTES`），那个目录已被清理，`NOTES/probe-*` 的源码没有保留。最小模板的全文仍在第 3 节；按本笔记做法写成的实际脚手架是 `dispatch-pilot/tests/support/world.ts`，用法见 `dispatch-pilot/README.md` 的「开发」一节。实现 #2 时又实测了几项，见第 10 节。下文其余内容保持原样。

本笔记原所在目录（下文简称 `NOTES`，已清理）：
`<scratchpad>/notes`

| 路径（已清理） | 内容 |
|---|---|
| `NOTES/types/` | 2.1.289 生成的全部类型：`claude-code/index.d.ts`（含 `claude-code/testing`，第 14124–15196 行）、`claude-code-tools/index.d.ts`、`claude-code-mcp/index.d.ts`、`tsconfig.generated.json`（即 `.claude-plugin/types/tsconfig.json`）、`tsconfig.mod-root.json`（引擎在 mod 根目录生成的那份）。与研究报告里旧 scratchpad 的那份**逐字节相同**（`diff` 为空）。用 `--plugin-dir` 加载一次任何 mod 即可重新生成。 |
| `NOTES/probe-min-src/` | **最小模板**：单文件 mod + 3 个测试，`claude plugin test` 3 pass，`validate --strict` 通过。全文见第 3 节。 |
| `NOTES/probe-seam-src/` | 覆盖面广的 probe：7 个测试文件、38 个测试全部通过；按「入口只组装、每项功能一个文件」的结构写。 |
| `NOTES/probe-extra/dup/` | 重复注册与 matcher 语义的 4 个小 mod（dup-a…d）。 |
| `NOTES/probe-extra/lint/` | `validate --strict` 常见报错的 11 个小 mod。 |
| `NOTES/mods-api-cheatsheet.md` | 事件与 `$` API 签名摘录（附 d.ts 行号）。现在是 `docs/research/mods-api-cheatsheet.md`。 |

复现：把第 3 节的最小模板写进任意目录，运行 `command claude plugin test <dir>`、`command claude plugin validate <dir> --strict`。`tsc -p <dir>` 需要先用 `--plugin-dir` 加载一次以生成 `.claude-plugin/types/`（`claude plugin test` 不生成它）。

---

## 1. 要点（出乎意料、会影响实现结构的发现）

1. **`$` 不能跨 import 传递。** 把 `$` 传给从另一个文件 import 的函数，加载时（和 `validate`）直接拒绝：
   `$ is passed to "callJev", imported from "./backend.ts": $ is followed only into a function declared in this same file, never across an import`。
   传给**同一文件**里声明的函数可以（`validate` 列出 `calls: $.ui.log (via say)`）。`on` 和 `options` 可以跨文件传（`registerEffort(on, options)` 这种「入口只组装」写法实测通过）。
   **对策（已实测）**：共用的、需要 `$` 的逻辑（决策后端调用、读 journal）写成接收闭包的纯函数，在 hook 所在文件里构造闭包：
   ```ts
   const io = { fetch: (url: string, init: HttpInit) => $.http.fetch(url, init), sleep: (ms: number, signal: AbortSignal) => $.clock.sleep(ms, { signal }) }
   const outcome = await callJev(io, body, apiKey, timeoutMs) // callJev 在 backend.ts，只认 io
   ```
   这样 `backend.ts` 也能被 Node 评测脚本复用（Node 端传入 `fetch`/`setTimeout` 实现的 io，已实测）。
2. **同一事件不带 matcher 注册两次，是加载时的静态检查，跨文件也算。** 即使第二个 `on` 在运行时不会执行的 `if` 分支里，也会报错；报错会指出两处位置：
   `on("turn.step") is registered twice without a matcher; the first is at …/one.ts:2`（dup-a）。
   带**相同** matcher 注册两次是允许的（dup-b，两个都执行）。
3. **hook 必须是函数字面量或函数名，不能是工厂函数的返回值**：`on("turn.step", mark("A"))` 报 `the hook is not a function literal or the name of one`。`const named: Hook<'turn.step'> = async function* (...) {...}; on('turn.step', named)` 可以（dup-c）。
4. **多个处理函数挂同一事件的写法（实测，dup-d）**：注册顺序就是嵌套顺序，先注册的在外层、先看到事件。
   - 只有一个可以不带 matcher；其余用「全匹配」matcher：`turn.step` 用 `{ turnId: /(?:)/ }`，`tool.call` 用 `{ tool: /(?:)/ }`，`prompt.submit` 用 `{ text: /(?:)/ }`（字段必须每次都存在）。
   - `{ agentId: /(?:)/ }` **不匹配**主 agent（字段缺失时 RegExp matcher 不命中），正好用来选「派出 agent + Workflow agent」的 step。`{ agentId: /^wf-/ }` 只匹配对应前缀；字面量 `{ turnId: 't' }` 是 `===`。
5. **测试里的「仅供测试的内联 mod」= 测试函数的 `on`。** `test(name, async ($, on) => …)` 里 `on` 注册的 hook 位于所有插件之下，就是被测 mod 的 `$.http.fetch`、`$.fs.read` 等调用的「core」。用它替换响应、并在闭包里记录请求做断言。
   `test(name, { plugins: [...] }, body)` 的内联插件**会运行**（它改写的 URL 到达了测试桩），但它的 `register` 被序列化后单独加载，**看不到测试文件里的任何变量**（实测 `typeof seen === 'undefined'`），所以不适合用来捕获请求。
6. **几种「空过」陷阱（全部复现过）**：测试不失败，但被测逻辑根本没跑。
   - 测试不给 `origin` 时，kit **不会**补默认值：`$.prompt.submit({ text, wait: false })` 到 mod 里 `e.origin` 是 `undefined`，读 `e.origin.kind` 抛错，hook 被**静默跳过**。→ 测试永远显式传 `origin: { kind: 'composer' }`；mod 里写 `e.origin?.kind`。
   - 没有 `http.fetch` 桩：mod 的 `$.http.fetch` reject（`no implementation for http.fetch`），mod 走放行分支，「effort 未改变」类断言照样通过。
   - 没有 `mock.clock(on)`：`$.clock.sleep` 立即 reject（`no implementation for clock.sleep`）；如果 mod 把 sleep 的 reject 当成「超时」，就会**误判超时**（实测 pending 被写成 null）。用到 `$.clock` 的 mod，每个测试都要 `mock.clock(on)`。
   - 缺 `ui.status`/`ui.log` 桩：只记一条 `$.ui.status dropped: HooksError: no implementation for ui.status`，hook 继续跑。
   - 以上信息只在**某个 expect 失败时**才会出现在 `the engine reported:` 块里。
   → 每个测试都要断言一个「正面产物」：捕获到的请求、状态行文字、注入的 context、最终 effort。
7. **测试的 `on` 自己也受「不带 matcher 不能注册两次」约束**：两次 `on('ui.status', …)` 不会当场抛错，而是第一次调用 `$` 时 reject：`test: hooks module did not load: on("ui.status") registered twice`。`world()` 之类的公共桩函数要设计成参数化，不要在单个测试里再覆盖同名桩。
8. **`settings hook 拦截` 的识别方式已实测可行**：测试里 `on('classic.PreToolUse', () => ({ deny: '…' }))` 代表 settings hook。被拦截时工具桩**不会被调用**，`$.tool.call` 和 mod 的 `tool.call` hook 拿到的都是 `{ isError: true, text: '<deny 理由>' }`——和普通工具失败长得一样。必须在 mod 的 `classic.PreToolUse` 包裹里按 `tool_use_id` 记下「被拦截」，`tool.call` 里再按同一 `tool_use_id` 区分（`tools.test.ts` 第 2、3 个测试）。没有注册 `classic.PreToolUse` 桩时 kit 自己放行，不报错。
9. **userConfig**：`test(name, { options: {...} }, body)` 传入；没给的字段由 manifest `default` 补上；**没有 default 的 string（例如 sensitive 的 apiKey）到 mod 里是 `""`，不是 `undefined`**。mod 判断「没配 key」要用 `!apiKey`。
10. **TypeScript**：mod 内部相对导入必须带 `.ts` 扩展名（Node 也要求），生成的 tsconfig 下 `tsc -p .` 报 `TS5097: An import path can only end with a '.ts' extension when 'allowImportingTsExtensions' is enabled`。在 mod 根目录手写
    `{"extends": "./.claude-plugin/types/tsconfig.json", "compilerOptions": {"allowImportingTsExtensions": true}}`
    后 `tsc -p .` 通过；用 `--plugin-dir` 真实加载一次后该文件**未被覆盖**（sha1 不变）。这与 CLAUDE.md「不要提交生成的 tsconfig」不冲突：这是手写的，是否提交由实现者决定。
11. **测试的 `$` 没有 `state` 名词**（`typeof $.state === 'undefined'`）。要观察 mod 的 `$.state` 写入，用 `on('state.set', async (_$, e, next) => { writes.push(e); return next(e) })`——必须调用 `next(e)`，kit 自己的内存 store 在下面接住。每个测试开始时所有 `$.state` 都是默认值（跨测试不残留，已实测）。
12. **`claude plugin test` 不加载其他已装插件**：本机启用的 jev-pilot 不参与（`$.command.run({ command: 'jev' })` 得到 `no implementation for command.run`）。每个测试文件在独立子进程里跑。`claude plugin test` 不接受 `--settings`，也不需要。

---

## 2. a–h 结论速览

| 项 | 结论 | 证据（测试文件 › 测试名） |
|---|---|---|
| a `http.fetch` 替换与断言 | **可行**。`on('http.fetch', (_$, e) => ({ value: { status, ok, headers, text } }))`；`e` 是 `{ url, init?: { method, headers, body } }`，在桩里 push 到数组即可断言 URL/headers/body。返回 `{ deny: '…' }` 让 mod 的 fetch reject。慢响应用 `await clock.sleep(ms)`。 | `probe-min-src/tests/seam.test.ts` 全部；`effort.test.ts` › decision at prompt.submit… |
| b `fs.read`/`exists`/`list` 替换 | **可行**。`fs.read` → `{ value: text }` 或 `{ deny: 'ENOENT …' }`；`fs.exists` → `{ value: boolean }`；`fs.list` → `{ value: FsEntry[] }`（`{ name, kind, size, mtimeMs, isLink }`）。`e.path` 到桩时是绝对路径（文档原话；probe 里 mod 用 `${$.plugin.root}/rules.md` 拼路径），用 `endsWith` 比较。 | `skills.test.ts` › session.start registers find_skill…；`seam.test.ts` › fake backend + fake disk |
| c 事件驱动与断言 | **全部可行**，写法见第 4 节：`prompt.submit`（origin、context）、`turn.step`（主/带 agentId，断言最终 effort/model）、`agent.spawn`（改写 model、拿 agentId）、`tool.call`（Workflow 改写、isError、deny）、`classic.PreToolUse`、`prompt.attachment`、`session.measure`、`session.compact`/`session.end`/`classic.SessionStart`、`command.run`、`$.tool.register` 的工具、`$.ui.status`/`$.ui.log`、`$.session.messages`、`$.model.complete`。 | 7 个测试文件，38 pass |
| d options / mock.* / 超时放行 | **可行**。`{ options }` 传 userConfig；`mock.store(on, {...})` 预置；想读 mod 写了什么就自己写 `store.get/set` 桩；`mock.env(on, { HOME })`；`mock.clock(on)` + `settle()` + `advance(timeoutMs)` 测 `Promise.race([$.http.fetch, $.clock.sleep])` 超时放行，**已通过**；「中途预判没及时回来」同样可测。 | `effort.test.ts` › backend timeout…、prefetch late…；`control.test.ts` |
| e `$.state` | **可行**。kit 自带内存实现，无需桩；每个测试从默认值开始；契约写在 `types/index.d.ts`，**顶层不能有 `export {}`**（见第 7 节）；`StateFamily<T>` 按 id 存（适合「轮 + agentId」）。 | `state.test.ts` |
| f 是否加载其他插件 | **不会**。只加载被测 mod + `plugins:` 里的内联插件。 | `kit.test.ts` › jev-pilot … is not loaded |
| g 多 test / 相对模块 / 纯 TS / Node | **都可以**。一个文件多个 `test()`、`describe()`；测试可 import mod 的相对模块，也能直接单测纯函数（无需 `$`）；Node 26.5 直接 `node x.ts`、`.mjs` import `.ts` 都可运行（无需 flag），限制：相对导入必须带 `.ts`，不能用 `enum`/`namespace`/参数属性；`import type … from 'claude-code'` 会被擦除，Node 能 import 含它的模块。 | `effort.test.ts` › pure module…；`scripts/node-check.ts`、`node-check.mjs`、`node-backend.ts` |
| h `validate --strict` | probe-seam、probe-min **通过**；它会跟随 import 列出所有 hooks、`$` 调用、env 读写、state 读写。常见报错原文见第 7 节。 | 第 7 节 |

---

## 3. 最小模板（全文，实测 3 pass）

目录 `NOTES/probe-min-src/`。单个 hooks 文件：`prompt.submit` 读一个文件、调决策后端（自带超时）、写 `$.state`；`turn.step` 每步写 effort、不碰 model。

`.claude-plugin/plugin.json`
```json
{
  "name": "probe-min",
  "version": "0.0.1",
  "description": "Minimal seam-1 template: fake backend at http.fetch, fake disk at fs.read",
  "author": { "name": "alexcz-a11y" },
  "types": "./types/index.d.ts",
  "userConfig": {
    "apiKey": { "type": "string", "title": "API key", "description": "Backend key", "sensitive": true },
    "timeoutMs": { "type": "number", "title": "Timeout", "description": "Backend timeout (ms)", "default": 800 }
  }
}
```

`hooks/hooks.json`
```json
{ "modules": ["./probe-min.ts"] }
```

`types/index.d.ts`（PluginState 契约；顶层不能 `export`）
```ts
declare module 'claude-code' {
  interface PluginState {
    'probe-min': {
      effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null
    }
  }
}
```

`hooks/probe-min.ts`
```ts
import type { Register } from 'claude-code'

const JEV_URL = 'https://api.typesafe.ai/v1/systemone' // 不要叫 URL：会遮蔽沙箱的全局 URL 类
const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

export const register: Register = (on, options) => {
  const apiKey = typeof options.apiKey === 'string' ? options.apiKey : ''
  const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : 800

  on('prompt.submit', async ($, e, next) => {
    if (e.origin?.kind !== 'composer') return next(e)
    const rules = await $.fs.read(`${$.plugin.root}/rules.md`).catch(() => '')
    const stop = new AbortController()
    const timer = $.clock.sleep(timeoutMs, { signal: stop.signal }).then(() => null, () => null)
    const call = $.http
      .fetch(JEV_URL, { method: 'POST', headers: { authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ state: { request: e.text, rules } }) })
      .catch(() => null)
    const response = await Promise.race([call, timer])
    stop.abort()
    const level = response?.ok ? (JSON.parse(response.text) as { effort?: string }).effort : undefined
    const effort = LEVELS.find((l) => l === level) ?? null
    await $.state.set({ plugin: 'probe-min', key: 'effort' }, effort)
    $.ui.status(effort ? `effort ${effort}` : '决策失败，已放行')
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const { value } = await $.state.get({ plugin: 'probe-min', key: 'effort' })
    if (e.agentId !== undefined || !value || e.effort === undefined) return yield* next(e)
    return yield* next({ ...e, effort: value })
  })
}
```

`tests/seam.test.ts`
```ts
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

// Everything registered on the test's `on` sits beneath the mod: it answers the
// mod's $ calls ({ value } or { deny }) and the engine events the mod passes on.
function world(on: On, answer: () => Promise<string | null> | string | null) {
  const fetched: { url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } }[] = []
  const read: string[] = []
  const statuses: (string | undefined)[] = []
  const efforts: unknown[] = []
  const clock = mock.clock(on) // the mod races $.clock.sleep: always mock the clock
  on('http.fetch', async (_$, e) => {
    fetched.push(e)
    const text = await answer()
    return text === null ? { deny: 'network down' } : { value: { status: 200, ok: true, headers: {}, text } }
  })
  on('fs.read', (_$, e) => {
    read.push(e.path) // absolute: compare with endsWith
    return e.path.endsWith('/rules.md') ? { value: '中文优先' } : { deny: `ENOENT ${e.path}` }
  })
  on('ui.status', (_$, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('turn.step', async function* (_$, e) {
    efforts.push(e.effort)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use' as const, usage: null }
  })
  return { fetched, read, statuses, efforts, clock }
}

async function step($: Engine, index: number) {
  for await (const _ of $.turn.step({ turnId: 't1', index, model: 'claude-opus-5-5', effort: 'xhigh', messageCount: 3 })) {
  }
}

test('fake backend + fake disk: the decision lands on every step', { options: { apiKey: 'k1' } }, async ($, on) => {
  const w = world(on, () => JSON.stringify({ effort: 'low' }))
  await $.prompt.submit({ text: '修个错别字', wait: false, origin: { kind: 'composer' } })
  await step($, 0)
  await step($, 1)
  expect(w.efforts).toEqual(['low', 'low'])
  expect(w.fetched[0]?.url).toBe('https://api.typesafe.ai/v1/systemone')
  expect(w.fetched[0]?.init?.headers).toEqual({ authorization: 'Bearer k1' })
  expect(JSON.parse(w.fetched[0]?.init?.body ?? '')).toEqual({ state: { request: '修个错别字', rules: '中文优先' } })
  expect(w.read).toHaveLength(1)
  expect(w.read[0]).toEndWith('/rules.md')
  expect(w.statuses).toEqual(['effort low'])
})

test('backend slower than the timeout: prompt passes, effort untouched, status says so', async ($, on) => {
  const holder: { w?: ReturnType<typeof world> } = {}
  const w = world(on, async () => {
    await holder.w!.clock.sleep(60_000) // answers after 60 s of mock time
    return JSON.stringify({ effort: 'low' })
  })
  holder.w = w
  const submitting = $.prompt.submit({ text: 'x', wait: false, origin: { kind: 'composer' } })
  await w.clock.settle()
  await w.clock.advance(800) // the manifest default timeoutMs
  await submitting
  await step($, 0)
  expect(w.efforts).toEqual(['xhigh'])
  expect(w.statuses).toEqual(['决策失败，已放行'])
})

test('backend unreachable ({ deny } makes $.http.fetch reject): fail open', async ($, on) => {
  const w = world(on, () => null)
  await $.prompt.submit({ text: 'x', wait: false, origin: { kind: 'composer' } })
  await step($, 0)
  expect(w.efforts).toEqual(['xhigh'])
  expect(w.statuses).toEqual(['决策失败，已放行'])
})
```

运行结果（`command claude plugin test NOTES/probe-min-src` 的原始输出）：
```
tests/seam.test.ts:
(pass) fake backend + fake disk: the decision lands on every step [15.71ms]
(pass) backend slower than the timeout: prompt passes, effort untouched, status says so [18.39ms]
(pass) backend unreachable ({ deny } makes $.http.fetch reject): fail open [7.10ms]

 3 pass
 0 fail
Ran 3 tests across 1 file. [0.15s]
```

`validate --strict` 输出：
```
  ❯ types ./types/index.d.ts declares on $: nothing (no EngineInterface member)
  ❯ types ./types/index.d.ts declares state: probe-min.effort
  ❯ ./probe-min.ts hooks: prompt.submit, turn.step
  ❯ ./probe-min.ts calls: $.clock.sleep, $.fs.read, $.http.fetch, $.state.get, $.state.set, $.ui.status
  ❯ ./probe-min.ts state writes: probe-min.effort
  ❯ ./probe-min.ts state reads: probe-min.effort
✔ Validation passed
```

**多文件结构的完整示例**在 `NOTES/probe-seam-src/`：入口 `hooks/probe-seam.ts` 只调用 `registerEffort/registerAgents/registerTools/registerSkills/registerControl(on, options)`；`hooks/request.ts` 是纯模块（mod、测试、Node 共用）；`hooks/backend.ts` 是接收 `io` 闭包的后端调用。最终一次运行（按文件汇总，原始输出每个测试一行 `(pass) …`）：

```
tests/agents.test.ts:   3 pass
tests/control.test.ts:  5 pass
tests/effort.test.ts:  10 pass
tests/kit.test.ts:      6 pass
tests/skills.test.ts:   3 pass
tests/state.test.ts:    3 pass
tests/tools.test.ts:    8 pass
 38 pass
 0 fail
Ran 38 tests across 7 files. [0.38s]
```
（`validate --strict` 通过；`tsc -p .` 在手写 tsconfig 下 exit 0。）

---

## 4. 每个事件 / API 的驱动与断言写法

约定：`$` 是测试的 `$`（扮演 Claude Code），每个方法触发同名事件并经过 mod 的 hook；`on` 注册的是「桩」。**所有 `on`/`mock.*` 必须在第一次调用 `$` 之前注册**（否则 `on("…") after the test first called $`）。`session.start` 不会自动触发。

### 4.1 桩的返回形状
- mod 的 **`$` 调用**（`http.fetch`、`fs.*`、`ui.status`、`ui.log`、`store.*`、`session.messages`、`model.complete`、`tool.register`、`command.register`…）：返回 `{ value: … }`；返回 `{ deny: '原因' }` 让 mod 那边 reject。桩**抛错**会被跳过（不等于 deny）。
- **引擎事件**（`prompt.submit`、`turn.step`、`tool.call`、`agent.spawn`、`prompt.attachment`、`command.run`、`session.*`、`classic.*`）：返回该事件自己的结果（如 `{ text }`、`{ result }`、`{ model, agentId }`）。
- `$.state` 和 `$.ui.invalidate` 由 kit 自己回答，不用桩。`$.clock` 用 `mock.clock(on)`。

### 4.2 `prompt.submit`
```ts
on('prompt.submit', (_$, e) => { submitted.push({ context: e.context, origin: e.origin }); return { text: e.text, context: e.context } })
await $.prompt.submit({ text: '…', wait: false, origin: { kind: 'composer' } })   // 必须给 origin
```
- 注入的 context：断言桩收到的 `e.context`（mod 写 `next({ ...e, context: [...(e.context ?? []), block] })`）。
- origin 过滤：`origin: { kind: 'task-notification' }` / `{ kind: 'peer' }` 时断言没有发请求。真实 `-p` 会话里用户 prompt 的 origin 是 `sdk`，交互式是 `composer`。
- 不给 origin → `e.origin` 为 `undefined`（见要点 6）。

### 4.3 `turn.step`（流式，`async function*`）
```ts
on('turn.step', async function* (_$, e) {
  sent.push({ index: e.index, effort: e.effort, model: e.model, agentId: e.agentId })
  return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use' as const, usage: null }
})
async function step($: Engine, index: number, agentId?: string) {
  const input = { turnId: 't1', index, model: 'claude-opus-5-5', effort: 'xhigh' as const, messageCount: 1, ...(agentId ? { agentId } : {}) }
  for await (const _chunk of $.turn.step(input)) {}   // 必须读到底
}
```
- 断言「每步都重设」：多次 `step()` 后 `sent.map(s => s.effort)` 全是决定的值。
- 断言「从不写 model」：`sent.map(s => s.model)` 等于输入的 model。
- 派出 agent / Workflow agent：传 `agentId`。haiku 这类没有 effort 的模型：输入里不放 `effort`，断言 `effort: undefined`。
- 桩是最底层：它收到的 `e` 就是 mod 最终发给引擎的值。

### 4.4 `agent.spawn`
```ts
on('agent.spawn', (_$, e) => { spawned.push({ model: e.model, prompt: e.prompt }); return { model: e.model ?? 'claude-opus-5-5', agentId: `agent-${spawned.length}` } })
const started = await $.agent.spawn({ tool_use_id: 'toolu_1', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: true, fork: false, prompt: '…', description: '…', subagentType: 'Explore' })
// started: { model: 'sonnet', agentId: 'agent-1' }；spawned[0].model 是 mod 改写后的值
```
- 测试的 `$.agent.spawn` 要完整的 `AgentSpawnInput`（`tool_use_id, provider, parentModel, background, fork` 都必填，否则 tsc 报 TS2739；运行时少字段也能跑，但建议写全，见 `agents.test.ts` 的 `spawnInput()`）。
- 拿到 `agentId` 后用同一 id 驱动 `turn.step`，断言该 agent 每步的 effort。
- fork：`fork: true`，断言没发决策请求（`requests` 计数不变）。

### 4.5 `tool.call`
```ts
on('tool.call', (_$, e) => (e.command === 'false' ? { result: 'exit 1', text: 'exit 1', isError: true as const } : { result: 'ok', text: 'ok' }))
const r = await $.tool.call({ tool: 'Bash', command: 'false' })     // r: { result, text, isError: true }
await $.tool.call({ tool: 'Bash', command: 'false', agentId: 'agent-1' } as never) // 派出 agent 的工具调用
```
- **Workflow 改写**：桩里记录 `e.script`，断言是改写后的脚本；mod 追加的说明在 `$.tool.call` 结果的 `context` 里。`scriptPath` 输入原样通过。
- **mod 拒绝（退回模式）**：mod 返回 `{ deny }` 时，工具桩不被调用，`$.tool.call` resolve 为 `{ deny: '…' }`（原样）。
- 用户拒绝权限在真实引擎里到 `tool.call` 是什么形状，kit 里**无法验证**（只能自己在桩里返回 `{ deny }` 模拟，jev-pilot 也是这么测的）。

### 4.6 `classic.PreToolUse`（识别 settings hook 拦截）
```ts
on('classic.PreToolUse', (_$, e) => (e.command === 'rm -rf /' ? { deny: 'blocked by policy hook' } : {}))
const blocked = await $.tool.call({ tool: 'Bash', command: 'rm -rf /' })
// blocked: { isError: true, text: 'blocked by policy hook' }；工具桩没有被调用
```
mod 侧：`on('classic.PreToolUse', async ($, e, next) => { const d = await next(e); if (d.deny !== undefined) 记下 e.tool_use_id; return d })`，`tool.call` 里看到 `isError` 时按 `tool_use_id` 判断是否拦截。顺序：`tool.call` hooks（mod）→ `classic.PreToolUse` hooks（mod）→ 测试的 `classic.PreToolUse` 桩 → 测试的 `tool.call` 桩。

### 4.7 `prompt.attachment`
```ts
on('prompt.attachment', (_$, e) => ({ text: e.text }))   // 引擎原文
await $.prompt.attachment({ type: 'skill_listing', text: LISTING, origin: { kind: 'engine' } })                    // → { text: null }
await $.prompt.attachment({ type: 'skill_listing', text: LISTING, origin: { kind: 'engine' }, agentId: 'agent-1' }) // → { text: LISTING }
```

### 4.8 `session.measure`
```ts
on('session.measure', (_$, e) => ({ changed: e.changed }))
await $.session.measure({ context: { window: 200_000, tokens: 50_000, percent: 25 }, rateLimits: [], cost: { usd: 1.5 }, changed: ['context', 'cost'] })
```
真实订阅会话里实测 `rateLimits` 有 2 项、`cost.usd` 有值。

### 4.9 `/compact`、`/clear`
没有 `session.clear` 事件。`/clear` = `session.end { reason: 'clear' }`，之后是 classic `SessionStart { source: 'clear' }`（不触发 `session.start`）。
```ts
on('session.compact', (_$, e) => ({ messages: e.messages }))
on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
on('classic.SessionStart', () => ({}))
await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'hi', toolUses: [] }] }) // 空 messages 会被拒
await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } } as never)
await $.classic.SessionStart({ source: 'clear' } as never)
```

### 4.10 `session.start` + `$.command.register` / `$.tool.register`
```ts
on('tool.register', (_$, e) => { tools.push(e); return { value: { tool: `mcp__<plugin>__${e.name}` } } })
on('command.register', (_$, e) => { commands.push(e); return { value: { command: e.name } } })
on('session.start', (_$, e) => ({ cwd: e.cwd }))
await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true } as never)
```
- 注册的工具由 mod 自己的 `on('tool.call', { tool: 'mcp__<plugin>__find_skill' }, …)` 回答；测试直接 `$.tool.call({ tool: 'mcp__probe-seam__find_skill', query: 'git' } as never)` 调用。`<plugin>` 是 plugin.json 的 `name`。
- 斜杠命令：`await $.command.run({ command: 'dp', args: 'off' } as never)` → mod 返回的 `{ text }`。

### 4.11 `$.ui.status` / `$.ui.log`
```ts
on('ui.status', (_$, e) => { statuses.push(e.text); return { value: undefined } })   // e.text: string | undefined
on('ui.log', (_$, e) => { logs.push({ text: e.text, to: e.to }); return { value: undefined } }) // e.to: 'transcript' | 'debug'
```
`$.ui.status`/`$.ui.log` 在 mod 里是同步 void 调用，但在 `await $.<事件>(...)` 返回时桩已经收到（实测）。真实 `-p` 会话没有状态行，`$.ui.status` 会写进 debug log：`$.ui.status (probe-seam): no status row in a headless session; kept here: …`。

### 4.12 `$.session.messages`
```ts
on('session.messages', () => ({ value: [{ role: 'user', text: '…', toolUses: [] }, { role: 'assistant', text: '…', toolUses: [{ tool_use_id: 'u1', tool: 'Read', input: {}, text: '工具输出' }] }] }))
```
断言发给后端的 `recent_context` 只含文字和工具名、不含工具输出（`effort.test.ts` 第一个测试）。

### 4.13 `$.model.complete`
```ts
on('model.complete', (_$, e) => { asked.push(e); return { value: { isAnswered: true as const, text: '…', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } } })
```

### 4.14 `$.store`、`$.env`
- `mock.store(on, { enabled: false })` 预置；`mock.store` 不返回句柄，要读 mod 写入的值就自己写 `store.get`/`store.set` 桩（`control.test.ts`）。
- `mock.env(on, { HOME: '/home/u' })`；未列出的变量为 unset。

### 4.15 `$.clock`：超时与「中途预判」
- 超时放行：`const p = $.prompt.submit(...)`（不 await）→ `await clock.settle()` → `await clock.advance(timeoutMs)` → `await p`。实测不加 `settle()` 也能过（`kit.test.ts`），加上无害。慢后端：桩里 `await clock.sleep(60_000)`；测试结束时桩还挂着也没问题。
- 中途预判（tool.call 发出、下一个 turn.step 取）：在途的 Promise 只能放模块级 `Map`（`$.state` 只收 JSON），`turn.step` 里 `Promise.race([prefetched, $.clock.sleep(grace)])`。测试：`const s = step($, 1)`（不 await）→ `await clock.advance(grace)` → `await s`，断言沿用上一档且状态行提示（`effort.test.ts` › prefetch late）。
- mod 里用 `AbortController` 取消输掉的 sleep：`$.clock.sleep(ms, { signal })`。

### 4.16 `$.state`
- kit 自带实现，每个测试从默认值（`undefined`，version 0）开始。
- 观察写入：`on('state.set', async (_$, e, next) => { writes.push({ key: e.key, value: e.value }); return next(e) })`。
- 契约（`types/index.d.ts`）写法：
  ```ts
  declare module 'claude-code' {
    interface PluginState {
      'dispatch-pilot': {                      // plugin.json 的 name
        pending: { effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' } | null
        turns: StateFamily<{ steps: number; failures: number }>   // id 可计算，如 `${turnId}:${agentId ?? 'main'}`
      }
    }
  }
  ```
  `$.state.set(ref, value)` 的 value 不能是 `undefined`（用 `null`）。ref 可以是 `as const` 常量，也可以 `{ ...FAM, id }`（实测通过 validate）；`plugin` 和 `key` 必须是字面量。

---

## 5. 已知坑（汇总）

1. `$` 不能传给跨文件 import 的函数（要点 1）。
2. 不带 matcher 的重复注册是跨文件的静态检查（要点 2）；hook 不能是工厂函数返回值（要点 3）。
3. 空过陷阱：不给 origin、缺 http.fetch 桩、缺 mock.clock（要点 6）。
4. 测试里同名桩不能注册两次（要点 7）。
5. settings hook 拦截在 `tool.call` 里就是 `isError`，必须靠 `classic.PreToolUse` 包裹按 `tool_use_id` 区分（要点 8）。
6. sensitive 字段没配时是 `""`（要点 9）。
7. `tsc` 需要 `allowImportingTsExtensions`（要点 10）。
8. `turn.step` 的桩和 mod hook 都必须是 `async function*`；测试必须把 `$.turn.step(...)` 的流读到底。
9. `$.session.compact` 的 `messages` 不能为空。
10. 内联插件（`plugins:`）不能闭包测试文件变量（要点 5）。
11. 真实 `-p` 会话里，`prompt.submit` 会一直等到决策返回或超时（实测一次 743 ms），这段时间用户在等；超时值要小。
12. `$.http.fetch` 没有超时也没有 signal：超时后请求仍在后台跑完，结果丢弃即可。

---

## 6. 共用的纯模块与 Node（g 的细节）

- Node v26.5.0 默认开启类型擦除：`node scripts/node-check.ts` 直接运行，没有警告；`.mjs` 文件 `import … from '../hooks/request.ts'` 也可以。
- 限制（实测报错）：相对导入必须写 `.ts`（`import { x } from "./lib"` → `ERR_MODULE_NOT_FOUND`）；`enum`、参数属性（`constructor(private a)`）报语法错误；`namespace` 未单独测，同属不可擦除语法，避免使用。
- 引擎这边也认 `.ts` 扩展名的相对导入（jev-pilot 也是这么写的），所以共用模块统一写 `./x.ts`。
- 共用模块里可以 `import type { HttpInit } from 'claude-code'`（Node 会擦除），不能有对 `'claude-code'` 的值导入。
- 评测脚本复用后端调用：`callJev(io, …)`。`scripts/node-backend.ts` 用假 fetch + `setTimeout` 版 sleep 跑通；接真实网络时 Node 端可写成 `fetch: (url, init) => fetch(url, init).then(async (r) => ({ status: r.status, ok: r.ok, headers: {}, text: await r.text() }))`（示意，未联网测）。
- `claude plugin test` 只跑 `*.test.ts(x)`，`scripts/` 下的文件不受影响；`validate` 只跟随 hooks 模块的 import。

---

## 7. `validate --strict` 常见报错原文（h）

| 写法 | 报错 |
|---|---|
| 契约文件顶层 `export {}` | `types: line 3: \`export\` at the top level is followed by \`type\` or \`interface\`: a contract exports types and nothing else` |
| 契约没声明就用 `$.state` | `probe-seam.pending is not declared: the manifest's types contract must name it in interface PluginState { probe-seam: { pending: ... } }` |
| `$` 跨 import 传递 | `$ is passed to "callJev", imported from "./backend.ts": $ is followed only into a function declared in this same file, never across an import` |
| 不带 matcher 重复注册（可跨文件） | `on("turn.step") is registered twice without a matcher; the first is at …/one.ts:2` |
| hook 是工厂函数返回值 | `the hook is not a function literal or the name of one` |
| `const s = $` / `const { ui } = $` | `$ itself is bound to a name (bound, passed, spread, returned or read)` |
| `$['ui'].log(...)` | `a computed or optional member access on $` |
| `$.env.get(name)`（变量） | `$.env.get takes a literal name as its first argument, so the variables a module reads and writes can be listed (got the variable name)` |
| `await import('./x.ts')` | `a dynamic import(); a hooks module imports its own files with an import declaration` |
| `import { z } from 'zod'` | `cannot import "zod" (from hooks/entry.ts): a hooks module imports its own files by relative path and "claude-code", nothing else` |
| `on(EV, …)`（事件名是变量） | `the event name passed to on() is not a string literal` |
| `const reg = on` | `"on" is used other than as a call or an argument to a function of the module's own (bound, spread or read)` |
| name 为 `claude-reserved` | `Plugin name "claude-reserved" is reserved: … cannot start with "claude-", "anthropic-", "anthropics-", or "cc-plugin-" …` |

这些错误在 `claude plugin test` 里表现为每个测试都失败：`HooksError: <plugin>: hooks module did not load: …`，外加一条 `(fail) the file ran to its end … a rejection nothing handled`。

通过时 `validate` 会列出：`hooks: …`（含 matcher，如 `turn.step{agentId=/"(?:)"/}`）、`calls: …`、`env reads/writes`、`state reads/writes`、`types … declares state: …`。

---

## 8. 未验证 / 测不到的

- 用户在权限对话框里拒绝时，真实引擎给 `tool.call` 的结果形状（kit 里只能模拟）。
- 热重载后 `$.state` 保留（kit 每个测试都是全新加载，测不到；需要在真实会话里改文件验证）。
- Sonnet 5.5 一轮中途改 effort 是否 400、`skill_listing` 清空后 Skill 工具能否按名加载：属于真实会话行为，不在接缝 1 范围。

## 9. 附带的一次真实请求（说明）

为确认手写 tsconfig 在真实加载后不被覆盖，跑了一次 `command claude -p "say ok" --plugin-dir probe-seam --settings '{"enabledPlugins":{"jev-pilot@jev-pilot":false}}'`。probe 的 `prompt.submit` 因此向 `https://api.typesafe.ai/v1/systemone` 发了**一次不带 key 的 POST**，返回 HTTP 403，放行路径正常（debug log：`$.ui.status (probe-seam): dp · 决策出错：HTTP 403`），没有产生费用。以后做真实加载验证时，probe 里的后端地址应指向不可达地址或加开关。

## 10. #2 实现时的补充实测（2.1.289）

实现 dispatch-pilot 骨架（#2）时，为了确定结构又做了几次实测。kit 指 `claude plugin test`，真实引擎指 `command claude -p ... --plugin-dir <mod> --settings '{"enabledPlugins":{"jev-pilot@jev-pilot":false}}' --debug-file <log>`。临时 probe 都在会话 scratchpad，已清理；结论都已经落实在 `dispatch-pilot` 的实现和测试里。

| # | 结论 | 怎么测的 |
|---|---|---|
| 1 | **同一次 dispatch 里，外层 hook 写入的 `$.state`，内层 hook 马上就能读到**，即使外层在写入之前先读过一次。d.ts 里「Every `get` of one dispatch reads one moment」没有造成影响。所以「外层功能写计划表、最内层核心按表写出」可行。 | 同一事件上两个 `turn.step` hook：外层先 get 再 set，内层 get。kit 和真实引擎都读到新值。 |
| 2 | **外层 hook 的 `$` 被闭包带进内层 hook 调用时照常可用**（`$.state.set`、`$.ui.status`、`$.ui.log`）。所以投票箱可行：功能在自己的 hook 里留下 `settle` 闭包，由核心在最内层调用。 | 外层 `prompt.submit` 把闭包放进模块级 Map，内层 `prompt.submit` 调用它。kit 和真实引擎都正常。 |
| 3 | **`prompt.submit` 的 `text` 与随后 `turn.start` 的 `text` 完全相同**（首尾空白也相同），并且 **`turn.start` 在 `prompt.submit` 的 `next(e)` 里面触发**：日志顺序是 PS → TS → PS resolved → 第 0 步。 | 真实引擎，`claude -p "  回复一个字：好  "`。 |
| 4 | **`turn.start` 只在主 agent 的轮触发**。派出 agent 的循环有自己的 `turnId`，但没有 `turn.start`。 | 研究报告 run A 的事件日志：只有一条 turn.start，两个子 agent 的 turn.step 和 turn.complete 各自带 agentId 和自己的 turnId。 |
| 5 | **一轮进行中用户发的新消息会送进这一轮，不开始新的一轮**：`prompt.submit` 带着这一轮的 `turnId`（`wait: false`），消息在下一步作为 `queued_command` 附件（"The user sent a new message while you were working: ..."）送给模型。在 SDK 模式下，`prompt.submit` 在出队时触发，也就是紧挨着那一步之前。d.ts 说引擎对 `wait` 为 true 的消息也同样排队，这个标志只是给 hook 看的。 | 真实引擎，`--input-format stream-json`：第一条消息让模型执行 `sleep 12`，6 秒后发第二条。 |
| 6 | **`$.session.messages()` 的行**：助手的输出每个 block 一行（只有 thinking 的行既无文字也无工具）；工具结果是没有文字、带 `toolResults` 的 user 行；user 行只有用户输入的文字，不含 system-reminder。 | 真实引擎，`claude -c -p` 接着前一个会话，在 `prompt.submit` 里列出全部行。 |
| 7 | **kit 里每个测试都是全新的模块实例**，模块级变量不会跨测试残留。 | 模块级计数器，两个测试各断言为 1。 |
| 8 | **测试最底层的 `prompt.submit` 桩可以在 dispatch 里调用测试的 `$.turn.start(...)`**，从而复现引擎「在 next 里开始一轮」的顺序。 | 见 `dispatch-pilot/tests/support/world.ts`。 |
| 9 | **在测试里注册 `state.get` 桩可以替 mod 的 `$.state.get` 作答**（返回 `{ value: { value, version } }`，其余 `next(e)` 交给 kit 自己的存储），用来模拟别的功能已经写好的值。 | `dispatch-pilot/tests/plan-table.test.ts` 的 `table()`。 |
| 10 | **`claude plugin test` 不生成 `.claude-plugin/types/`**，只有 `--plugin-dir` 加载才会生成；已经有手写的 `tsconfig.json` 时不覆盖，只会在 types 目录里写一个 `.gitignore`。 | 真实引擎加载后检查文件。 |
| 11 | **debug log 不记录 `pluginConfigs` 里的 option 值**；通过 `--settings` 的 `pluginConfigs["<name>"].options` 传入的敏感字段能到达 mod。引擎自己的 `$.http.fetch` 日志只记方法、URL、状态码、耗时和长度，不记请求头。 | 真实引擎，先用假 key（canary）：debug log 里出现 0 次，请求得到 401，放行路径正常。再用真 key：出现 0 次。 |
| 12 | 真实 Jev（jev-1.13.0），发消息时的 effort 请求（英文问题、Score、无上下文）：输入 618–648 token，`$.http.fetch` 耗时 433–522 ms（新进程的第一个请求），与 Node `fetch` 的 526 ms 相当。中文问题 746 token，Choice 写法 656 token，两者 API 都接受。 | `dispatch-pilot/scripts/decide.ts` 和真实引擎运行。 |

对第 1 节要点 6（空过陷阱）的补充：`dispatch-pilot` 的脚手架 `world()` 总会装上 `mock.clock`、`http.fetch` 桩（没有给 `backend` 时回答 HTTP 500）和 `ui.status`、`ui.log` 桩，并在 `w.submit` 里总是带上 origin，从结构上避开了这几类空过。
