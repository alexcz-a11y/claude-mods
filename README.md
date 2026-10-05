# claude-mods

作者自制的 [Claude Code mod](https://code.claude.com/docs/en/plugins/mods/overview) 的集合，同时是名为 `alex-mods` 的 Claude Code mod marketplace。根目录下每个子目录是一个独立的 mod，可以单独安装。

## mod 列表

| mod | 说明 | 文档 |
|---|---|---|
| `dispatch-pilot` | 在 Claude 之外调用一个决策模型（Jev 或 Clef，二选一），决定主 agent 每一轮的 effort、派出 agent 和 Workflow 里 agent 的模型和 effort，并推荐相关的 skill。只面向 Claude Code 订阅 | [dispatch-pilot/README.md](dispatch-pilot/README.md) |

## 安装

```bash
claude plugin marketplace add alexcz-a11y/claude-mods
claude plugin install dispatch-pilot@alex-mods --scope user
```

mod 需要 Claude Code 2.1.287 及以上。每个 mod 的要求、配置和用法见它自己的 README。

写 mod 的约定、测试和发布方式见 [CLAUDE.md](CLAUDE.md)。
