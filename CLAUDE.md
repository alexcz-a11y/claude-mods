# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 仓库定位

本仓库收录作者自制的 Claude Code **mod**（不是普通的 plugin 或 skill）。根目录下每个子目录都是一个独立的 mod，可以单独加载、测试和分发。

- 官方介绍：https://claude.com/blog/claude-code-mods
- 入门教程：https://claude.dev/blog/getting-started-with-claude-code-mods/
- 文档：https://code.claude.com/docs/en/plugins/mods/overview （同目录下还有 `create`、`api`、`events`、`interface`、`test`、`reference`、`troubleshoot`）
- 官方示例集合：https://github.com/anthropics/claude-code-playground/tree/main/claude-code/mods （布局与本仓库相同）
- 需要 Claude Code v2.1.287 及以上，mod 默认启用

## mod 是什么

mod 是一种 plugin：只要 plugin 的 `hooks/hooks.json` 里有 `modules` 键，它就是 mod。它由 TypeScript/JavaScript 事件处理函数组成，在 Claude Code 进程内运行，能做的事情包括：

- 观察、改写或接管事件，例如改写 prompt；拦截、改写或重试 tool call；批准或拒绝权限请求；在 Claude 读到工具输出之前脱敏
- 绘制界面：pane、band（`AbovePrompt` 渲染位）、`$.ui.status`、toast，或者替换内置渲染

settings hook 是 settings 文件里配置的 shell 命令、HTTP 请求或 prompt。在本仓库里，"hook" 一律指 mod 的处理函数，不是 settings hook。

运行时要点：

- 模块运行在自己的沙箱里，没有 DOM、Node API 和 `setTimeout`，与外界的交互都要通过 `$`。可用的全局对象有 `URL`、`TextEncoder`、`AbortController` 和 `crypto.subtle`。
- Hook 签名为 `on(event, [matcher], async ($, e, next) => ...)`，常见写法有三种：
  - 观察：`const r = await next(e); return r`
  - 改写：`return next({ ...e, ... })`
  - 直接回答：不调用 `next`，例如 `return { deny: "…" }`
- 多个 mod 挂在同一事件上时，按加载顺序执行：先加载的最先看到事件，最后看到结果。
- 同一事件不带 matcher 注册两次会报错。
- 渲染 hook 的 props 在 `e.props` 上，`e` 顶层只有 `component`、`surface`、`requestId` 和 `viewport`。不需要绘制时返回 `next(e)`。
- 界面里用单宽字符，不要用 emoji。

## 单个 mod 的结构

```
<mod>/
├── .claude-plugin/plugin.json   # 标准 manifest：name、version、description、author；userConfig 会作为 options 传给 register；用 $.state 时 "types": "./types/index.d.ts"
├── hooks/
│   ├── hooks.json               # {"modules": ["./<mod>.mjs"]}，每个 mod 只有一个模块，路径相对本文件
│   └── <mod>.mjs|ts|tsx         # ES module，导出 register(on, options)
├── types/index.d.ts             # 手写的 PluginState 契约，需提交；只在用到 $.state 时需要
├── tests/*.test.ts(x)           # 可选
└── README.md                    # 说明用途、运行方式，并注明测试时的 Claude Code 版本
```

- 没有构建步骤，Claude Code 直接加载 `.js`、`.mjs`、`.ts`、`.tsx` 等文件，`.tsx` 和 `.jsx` 支持 JSX。
- `.claude-plugin/types/` 是 Claude Code 每次通过 `--plugin-dir` 加载 mod 时生成的类型和 tsconfig。它是当前版本事件和 `$` API 的权威来源，比网页文档更准，但不提交（已写入 `.gitignore`）。
- 热重载会重新执行 `register`，`session.start` 也会再触发一次，模块级变量会被重置。需要保留的值放进 `$.state`；跨会话共享的放进 `$.store`，它本机共享、总上限 4 MiB，存放在 `~/.claude/plugins/store/`。

## 常用命令（在仓库根目录执行，`<mod>` 换成子目录名）

```bash
claude --plugin-dir ./<mod>                          # 本次会话加载这个 mod，保存后自动热重载
claude --plugin-dir .                                # 加载根目录下所有含 .claude-plugin/plugin.json 的子目录
claude plugin validate ./<mod> --strict              # 静态检查；--strict 把警告当错误，--json 输出机器可读结果
command claude plugin test ./<mod>                   # 运行该目录下全部 *.test.ts(x)，不需要会话、登录或网络
tsc -p ./<mod>                                       # 用生成的 tsconfig.json 做类型检查（需要先加载过一次 mod）
claude -p "/<command>" --plugin-dir ./<mod>          # 非交互地验证 mod 注册的命令
claude --debug-file ./mod-debug.log --plugin-dir ./<mod>   # 调试；日志里出现 "hooks module <mod>@inline loaded" 说明加载成功
```

- `claude plugin test` 用 `command claude` 调用。如果 shell 里 `claude` 是带参数的 alias，它会报 `not run from this spelling` 并拒绝运行。
- 无法只运行单个测试：不支持过滤参数、单文件路径和 `.only`。想单独跑某个测试，只能临时把其他测试移走。
- 在会话中执行 `/plugin`，会显示类似 `1 mod active · <mod>` 的一行，用来确认 mod 已加载。

## 测试（`claude-code/testing`）

- 测试套件导出 `describe`、`expect`、`mock`、`test` 和 `tier`。
- 打桩必须在第一次调用 `$` 之前注册。
- `session.start` 不会自动触发，需要在测试里手动触发。
- 可用的 mock 有 `mock.clock(on)`、`mock.store(on, {...})` 和 `mock.env(on, {...})`。
- 测试界面绘制用 `$.ui.mount({...})`，再配合它的 `press`、`input`、`select` 和 `find`。
- 一个测试文件里如果没有 `test()`，会以 `declares no test(): nothing ran` 失败。

## 编写约束（`claude plugin validate` 会检查）

- `$` 的 API 必须完整写出，例如 `$.store.get(...)`。不能给 `$` 起别名、解构，也不能用计算下标访问。
- 事件名必须是字符串字面量；不要遮蔽 `on`。
- 只允许插件内部的相对导入。唯一允许的裸导入是 `claude-code`，测试中可用 `claude-code/testing`。禁止动态 `import()` 和 `require`。
- mod 的 `name`（以及目录名）不能以 `claude-`、`anthropic-`、`anthropics-`、`cc-plugin-` 开头，也不能恰好是 `claude`、`anthropic`、`anthropics`、`claude-code` 或 `claude-mods`。目录名用 kebab-case，并与 `plugin.json` 中的 `name` 保持一致。
- 每个 hook 有 10 秒超时（`prompt.edit` 只有 50 ms）。command、tool 和 pane 的名字只能用字母、数字、`_`、`-`，最长 64 个字符。

## 把 Claude 写的 mod 收进本仓库

用 `/plugin-authoring` 让 Claude 生成的 mod 会写到 `~/.claude/dev-mods/<session-id>/<mod>/`，这个目录在 `cleanupPeriodDays` 之后会被删除。完成后把它复制到本仓库的新子目录中，跑一遍 validate/test，再提交。

## 分发（marketplace）

本仓库将作为一个 marketplace 发布，布局沿用 playground 的扁平结构：每个 mod 是根目录下的 `./<mod>`。清单 `.claude-plugin/marketplace.json` **尚未创建**，它的格式要点如下：

- 必填字段：`name`、`owner`（必须有 `owner.name`）和 `plugins`。
- `plugins` 里的每一项至少要有 `name` 和 `source`，并建议写上 `description`。
- `source` 相对于仓库根目录，必须以 `./` 开头，不能包含 `..`。
- 每一项的 `name` 必须与对应 mod 的 `plugin.json` 里的 `name` 一致，否则安装时会报 `not found in marketplace`。
- marketplace 的 `name` 不要使用 `claude-mods`，也不要用其他模仿官方的名字。
- 新增 mod 时，必须同时在 `plugins` 中加一项。
- 用 `claude plugin validate .` 只会检查清单本身，各 mod 还要分别 validate。

用户安装方式：

```bash
claude plugin marketplace add alexcz-a11y/claude-mods
claude plugin install <mod>@<marketplace-name> --scope user
```

版本管理：发版时递增 `plugin.json` 的 `version`，或者不写 `version`，改用 commit SHA。已发布的 mod 不要改名；确实需要时，用 marketplace 的 `renames` 字段处理。
