# claude-mods

作者自制的 [Claude Code mod](https://code.claude.com/docs/en/plugins/mods/overview) 的集合，同时是名为 `alex-mods` 的 Claude Code mod marketplace。根目录下每个子目录是一个独立的 mod，可以单独安装。

## mod 列表

| mod | 说明 | 文档 |
|---|---|---|
| `dispatch-pilot` | 在 Claude 之外调用一个决策模型（默认 pplx，没有 Perplexity key 时退回 Jev），决定主 agent 每一轮的 effort、派出 agent 和 Workflow 里 agent 的模型和 effort，并推荐相关的 skill。只面向 Claude Code 订阅 | [dispatch-pilot/README.md](dispatch-pilot/README.md) |
| `prefer-search-tools` | auto 模式的提醒教主 agent 用 Bash 的 `grep` 和 `find` 搜索；它只改写这一分句，让主 agent 改用 Grep 和 Glob 工具，提醒的其余内容不动；子 agent 收不到这段提醒，就在它的任务末尾追加同一句 | [prefer-search-tools/README.md](prefer-search-tools/README.md) |

## 安装

```bash
claude plugin marketplace add alexcz-a11y/claude-mods
claude plugin install dispatch-pilot@alex-mods --scope user
claude plugin install prefer-search-tools@alex-mods --scope user
```

装好后重启 Claude Code，或者在开着的会话里运行 `/reload-plugins`。

mod 需要 Claude Code 2.1.287 及以上。每个 mod 的要求、配置、更新和用法见它自己的 README。

写 mod 的约定、测试和发布方式见 [CLAUDE.md](CLAUDE.md)。
