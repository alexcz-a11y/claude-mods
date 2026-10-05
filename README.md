# claude-mods

作者自制的 [Claude Code mod](https://code.claude.com/docs/en/plugins/mods/overview) 的集合，同时是名为 `alex-mods` 的 Claude Code mod marketplace。根目录下每个子目录是一个独立的 mod，可以单独安装。

## mod 列表

| mod | 说明 | 文档 |
|---|---|---|
| `dispatch-pilot` | 在 Claude 之外调用一个决策模型（Jev 或 Clef，二选一），决定主 agent 每一轮的 effort、派出 agent 和 Workflow 里 agent 的模型和 effort，并推荐相关的 skill。只面向 Claude Code 订阅 | [dispatch-pilot/README.md](dispatch-pilot/README.md) |

## 安装

`dispatch-pilot` 还在 `dp/integration` 分支上，没有合并到 `main`；`main` 上的 marketplace 还没有列出任何 mod。合并到 `main` 之前，请从本地克隆安装：检出 `dp/integration`，再用克隆的路径添加 marketplace。

```bash
git clone --branch dp/integration https://github.com/alexcz-a11y/claude-mods.git
claude plugin marketplace add ./claude-mods
claude plugin install dispatch-pilot@alex-mods --scope user
```

也可以在添加 marketplace 时指定分支：`claude plugin marketplace add alexcz-a11y/claude-mods#dp/integration`。合并到 `main` 之后，去掉 `#dp/integration` 即可。装好后重启 Claude Code，或者在开着的会话里运行 `/reload-plugins`。

mod 需要 Claude Code 2.1.287 及以上。每个 mod 的要求、配置、更新和用法见它自己的 README。

写 mod 的约定、测试和发布方式见 [CLAUDE.md](CLAUDE.md)。
