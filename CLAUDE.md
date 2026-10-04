# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 仓库定位

本仓库收录作者自制的 Claude Code **mod**（不是普通的 plugin 或 skill）。根目录下的每个子目录都是一个独立的 mod，可以单独加载、测试和分发。

- 官方文档：https://code.claude.com/docs/en/plugins/mods/overview （另见同目录下的 `create`、`reference`、`troubleshoot`）
- 需要 Claude Code v2.1.287 及以上版本，mod 默认启用

## mod 是什么

mod 是一种 plugin：只要 plugin 的 `hooks/hooks.json` 里有 `modules` 键，它就是 mod。mod 由 JavaScript/TypeScript 事件处理函数组成，运行在 Claude Code 自己的进程里，能观察、修改或接管事件（`tool.call`、`prompt.submit`、`turn.complete`、`ui.render` 等）。它也能在界面上绘制：pane、band（`AbovePrompt` 渲染位）、status line 和 toast。

settings hook 是写在 settings 文件里的 shell 命令、HTTP 请求或 prompt。在本仓库里，"hook" 一律指 mod 的处理函数，不是 settings hook。

## 单个 mod 的结构

```
<mod>/
├── .claude-plugin/plugin.json   # 标准 plugin manifest（name、version、description、author）；userConfig 会作为 options 传给 register
├── hooks/
│   ├── hooks.json               # {"modules": ["./register.js"]}，数组里只放一个相对于本文件的路径
│   └── register.js|ts           # ES module，导出 register(on, options)
├── types/index.d.ts             # 仅在用到 $.state 或给 mods API 新增 namespace 时需要
└── *.test.ts(x)                 # 可选测试
```

- 没有构建步骤，Claude Code 直接加载 `.js` 和 `.ts`。
- `.claude-plugin/types/`（以及缺省时的根 `tsconfig.json`）由 Claude Code 自动生成。它是当前版本事件和 `$` API 的权威来源，比网页文档更准。
- Hook 签名：`on(event, [matcher], async ($, e, next) => ...)`。

## 常用命令（在仓库根目录执行，`<mod>` 换成子目录名）

```bash
claude --plugin-dir ./<mod>                         # 在本次会话中加载，可重复传入多个；保存后自动热重载
claude plugin validate ./<mod> --strict             # 静态检查，--strict 把警告当错误；--json 输出机器可读结果
claude plugin test ./<mod>                          # 运行 *.test.ts，不需要会话、登录或网络
tsc -p ./<mod>                                      # 用生成的 tsconfig.json 做类型检查
claude -p "/<command>" --plugin-dir ./<mod>         # 非交互地验证 mod 注册的命令
claude --debug-file ./mod-debug.log --plugin-dir ./<mod>   # 调试；看到 "hooks module <mod>@inline loaded" 说明加载成功
```

在会话中执行 `/plugin`，会显示类似 `1 mod active · <mod>` 的一行，用来确认 mod 已加载。

## 编写约束（`claude plugin validate` 会检查）

- `$` 的 API 必须完整写出，例如 `$.store.get(...)`。不能给 `$` 起别名、解构，也不能用计算下标访问。
- 事件名必须是字符串字面量；不要遮蔽 `on`。
- 只允许插件内部的相对导入。唯一允许的裸导入是 `claude-code`，测试中可用 `claude-code/testing`。禁止动态 `import()` 和 `require`。
- mod 的 `name` 不能像 Anthropic 官方的名字，例如**不能以 `claude-` 开头**。仓库名 `claude-mods` 不受此限制，但子目录里的 mod 要避开这个前缀。
- 热重载会重新执行 `register`，模块级变量会被重置。需要保留的状态放进 `$.state`，或者放进 `$.store`（本机所有会话共享，总上限 4 MiB）。
- 每个 hook 有 10 秒超时（`prompt.edit` 只有 50 ms）。command、tool 和 pane 的名字只能用字母、数字、`_`、`-`，最长 64 个字符。

## 把 Claude 写的 mod 收进本仓库

用 `/plugin-authoring` 让 Claude 生成的 mod 会写到 `~/.claude/dev-mods/<session-id>/<mod>/`，这个目录在 `cleanupPeriodDays` 之后会被删除。完成后把它复制到本仓库的新子目录中，再跑 validate/test 并提交。

## 分发

官方推荐用 marketplace 分发：一个仓库，每个 plugin 占一个目录，这和本仓库的布局一致。仓库根目录目前还没有 marketplace 清单，添加前请先阅读官方的 plugin 发布文档，确认清单格式。每个 mod 的 README 中应注明测试时使用的 Claude Code 版本。
