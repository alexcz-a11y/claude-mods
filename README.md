# claude-mods

作者自制的 [Claude Code mod](https://code.claude.com/docs/en/plugins/mods/overview) 的集合，同时是名为 `alex-mods` 的 Claude Code mod marketplace。根目录下每个子目录是一个独立的 mod，可以单独安装。

## mod 列表

| mod | 说明 | 文档 |
|---|---|---|
| `dispatch-pilot` | 在 Claude 之外调用一个决策模型（默认 Nace 的 Drex，也可以改用 TypeSafe 的 Jev），在你发消息时和一轮进行中定主 agent 的 effort，为派出的 agent 定模型和 effort，并最多推荐一个 skill 代替完整的 skill 列表；时间轴和面板显示每次判断和实际发出的档位。Code Mode 里也能用，需要 Claude Code 2.1.327 及以上。只面向 Claude Code 订阅 | [dispatch-pilot/README.md](dispatch-pilot/README.md) |

## 安装

```bash
claude plugin marketplace add alexcz-a11y/claude-mods
claude plugin install dispatch-pilot@alex-mods --scope user
```

装好后重启 Claude Code，或者在开着的会话里运行 `/reload-plugins`。

mod 需要 Claude Code 2.1.287 及以上。每个 mod 的要求、配置、更新和用法见它自己的 README。

写 mod 的约定、测试和发布方式见 [CLAUDE.md](CLAUDE.md)。
