# Dispatch Pilot Extras

[Dispatch Pilot](../dispatch-pilot/README.md) 的另一半。它把 `tool.call`、`agent.spawn` 和 `classic.PreToolUse` 这三个事件接到 Dispatch Pilot 上：每个 hook 只有几行，逻辑、状态、决策模型和密钥都在 Dispatch Pilot 里（通过它加到 `$` 上的 `$.dispatchPilot`）。它自己不做任何判断，不发任何请求，没有配置。

## 为什么拆成两个

Claude Code 的 Code Mode（实验功能，2.1.323 起）启动时会检查已启用的 mod：只要有一个 mod 的 hooks 模块注册了 `tool.call`、`agent.spawn`、`classic.PreToolUse` 这类事件，Code Mode 就不开，提示 `it doesn't yet work with an installed mod (a plugin with JavaScript hooks) that checks tool calls`。所以这几个事件的 hook 单独放在这个 plugin 里：

| 会话 | 装哪些 | 效果 |
| --- | --- | --- |
| 普通会话 | Dispatch Pilot 和 Dispatch Pilot Extras | 全部功能，和拆分之前一样 |
| Code Mode 会话 | 只留 Dispatch Pilot（禁用这一个） | 发消息时的 effort、一轮中途的 effort、派出 agent 的模型和 effort、skill 推荐照常；Workflow 里的 agent、看图核对、截图接管不工作 |

在一个会话里禁用它：`/plugin` 里关掉 `dispatch-pilot-extras`，或者启动时带上

```bash
claude --settings '{"enabledPlugins":{"dispatch-pilot-extras@alex-mods":false}}'
```

## 安装

```bash
claude plugin marketplace add alexcz-a11y/claude-mods
claude plugin install dispatch-pilot-extras@alex-mods --scope user
```

它依赖 `dispatch-pilot`。单独装它没有效果：`$.dispatchPilot` 不存在时，每个事件都按引擎原样往下走。

## 要求

和 Dispatch Pilot 相同（Claude Code 2.1.300 及以上）。**0.15.0 测试用的是 Claude Code 2.1.325**。
