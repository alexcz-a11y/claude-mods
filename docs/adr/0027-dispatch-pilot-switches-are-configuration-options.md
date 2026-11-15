# Dispatch Pilot：功能开关是配置里的选项，配置是开关唯一的存放处；`escalateAfter` 填 0 表示关闭

2026-11-13 用户的决定。起因是一次排查：用户以为「失败几次后升 effort」设的是 6，实际 6 写在 `unresolvedMaxAfter` 上，`escalateAfter` 存的是 0；0 超出 1–20 的范围，被 `readConfig` 静默夹成 1，加上 `escalateLimit` 0，派出的 agent 每失败一次就升一档 effort，两次到 max。用户要求：0 就表示关闭；`/dp` 的 17 个功能开关全部加进 plugin 的配置；配置和 `/dp` 之间以配置为准；每个选项的说明改短、改直白；废弃的参数处理从代码里删掉。

## 决定

- **每个开关是 `userConfig` 的一个布尔选项。** 选项名是开关名的驼峰写法（`midrun-steps` 是 `midrunSteps`，`core/switches.ts` 的 `optionOf`），总开关是 `enabled`；`default` 是开关的默认值，`description` 和开关的 `info` 一字不差，`title` 是简短的中文名。manifest 从 22 项变成 40 项。
- **配置是开关唯一的存放处。** 模块加载时入口把选项交给 `loadSwitches`，`isOn` 读它。`/dp <功能> on|off`、`/dp on|off` 和依据面板的按钮先在内存里翻转，再用 `$.config.set({ key: 'dispatch-pilot.<选项>', value })` 写进配置；引擎随即带着新选项重新加载模块。`$.store` 不再存开关。
- **旧开关搬一次。** 0.13.0 及更早存在 `$.store` 的 `switches`，在 `session.start` 逐个写进配置（行上已经是这个值的不写），全部写成后删掉 store 的键；没有代码定义的名字丢掉。每次写入都会重载模块、再来一次 `session.start`，所以删 store 放在最后，由发现没有东西可写的那一次加载来做，中途被打断也不丢。
- **写不进配置的会话。** `claude -p` 的会话没有 plugin 的配置行，`$.config.set` 抛错：翻转只留在那次加载里，`/dp` 的回答写明原因；旧开关只在那次加载里生效，store 留给写得成的会话。
- **`escalateAfter` 的范围改成 0–20，0 表示关闭。** 失败照常计数、照常显示，但不升 effort、不换模型，主 agent 的一轮也不记为卡住（`facts.stuck` 为否，规则 R4 不触发）。之前存着 0 的用户，行为从「每失败一次就升」变成「不升」。
- **数值选项不声明 `min`、`max`。** 实测（2.1.323）声明之后，`/config` 会拒绝越界的输入，但设置文件里已经存着的越界值会让整个模块加载失败。老用户存着越界值的可能性不能排除，所以范围仍由 `readConfig` 夹取，说明里写明范围。
- **删掉 Clef 的残留处理。** `removedDecisionModel` 和它在会话开始时写的那行日志删掉：Clef 在 0.4.0 移除，引擎本来就把选项列表之外的值当成没设。

## 实测（Claude Code 2.1.323，一个带两个 `userConfig` 字段的探针 mod）

- 交互会话里 `$.config.list()` 有 plugin 的非敏感、非列表选项，键是 `<plugin 名>.<字段>`；`$.config.set` 回 `{ value }`，写进 `pluginConfigs["<名>@<来源>"].options`，模块当场重载（`options changed — reloaded`），旧实例的 hook 继续跑完。
- `claude -p` 的会话里没有 plugin 的行，`$.config.set` 以 `no /config row with key …` 抛错。
- 声明了 `min`、`max` 的字段：越界写入回 `{ deny }`；设置文件里存着越界值时模块加载失败。
- Dispatch Pilot 自己（终端的交互会话）：会话开始时 store 里的 `midrun-steps` 写成了 `midrunSteps: true`，重载后的那次加载删掉了 store 的 `switches`；`/dp signals off` 和 `/dp signals on` 各写了一次 `signals`，各重载一次，下一个会话读到的就是写进去的值。

## 代价和没做的

- `/dp` 翻转一个开关现在会重载模块：模块级变量（投票箱、命令轮的命令记录、限速队列）从头开始。它们本来就按「热重载会丢、丢了代价小」来写，但以前只有开发时和改 `/config` 时才遇到。
- Desktop、VS Code 和手机端有没有 plugin 的配置行没有测；没有的话，面板按钮的翻转在那里只管当次加载。
- 配置对话框（`/plugin configure`）现在有 40 项。
- 数值越界仍然是静默夹取，只有 `escalateAfter` 的 0 有了明确的意思。
