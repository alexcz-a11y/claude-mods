# dp-dashboard-prototype

**原型，用完即弃。** dispatch-pilot 新终端界面的三个方案（页脚摘要 + band 仪表盘 + 诊断面板），全部用假数据，用 `/dpp` 切换，方便在真实 Claude Code 里并排比较后选一个。

测试时的 Claude Code 版本：2.1.289。不发请求给模型，不联网，不用 `$.state` / `$.store`。只画终端 surface，其它 surface 一律 `next(e)`。

## 运行

```bash
cd ~/Documents/claude-mods-prototype
claude --plugin-dir ./dp-dashboard-prototype \
  --settings '{"enabledPlugins":{"dispatch-pilot@alex-mods":false}}'
```

第二行是为了不让真实的 dispatch-pilot 同时加载。进去后输入 `/dpp`。

## 命令

| 命令 | 作用 |
|---|---|
| `/dpp a` `b` `c` / `next` | 切换方案（A Cockpit、B Timeline、C Tree），弹 toast「原型 B · Timeline」 |
| `/dpp scene <名>` / `scene next` | 固定一个场景：`running agents workflow stuck notrouted many idle` |
| `/dpp play` / `stop` | 每 3 秒自动换场景 |
| `/dpp log` / `close` | 打开或关闭诊断面板 |
| `/dpp sel <n>` `next` `prev` | 选中节点（方案 C；0 是主 agent）。也可以在输入框为空时直接按数字键 |
| `/dpp fold <轮>` | 折叠或展开一轮（方案 B 的面板）。也可以点轮标题 |
| `/dpp status on` / `off` | 额外打开 `$.ui.status` 一行摘要（引擎会加 `⚠ 插件名:` 前缀，去不掉） |

band 标题行始终写着当前方案和场景。band 用引擎自带的 `[-]` 或 ctrl+x ctrl+a 折叠，折叠后页脚右侧的摘要仍在。

## 三个方案

- **A Cockpit**：band 分栏。左边主 agent 的 effort 仪表（Raster 渐变，五档），中间 agent 表，右边 Workflow 进度条（Raster）和技能。面板是平铺的编号日志，每条左侧有色带，概率画成五格小柱。
- **B Timeline**：band 是按时间排列的事件流，顶上一行状态条。面板按轮分组，可折叠，概率画成一根 100% 堆叠条（Raster，段边界精确到格内八分之一）。
- **C Tree**：band 是以主 agent 为根的树，Workflow 的 agent 是子节点，节点带编号，数字键选中。面板是主从结构：上面节点列表，下面选中节点的依据和概率条。

宽度分档：band 不超过各自的内容宽度，窄到一定程度（含面板 dock 在右侧时）自动换成紧凑排版；面板 inline（终端不足 110 列）时，band 被引擎挤到只剩 1 到 3 行，就退成一行摘要。

## 开发

只有一个模块 `hooks/dp-dashboard-prototype.tsx`，数据在 `hooks/proto/data.ts`，三个方案在 `cockpit.tsx` `timeline.tsx` `tree.tsx`，共用的色板和块字符、Raster 工具在 `kit.tsx`。

```bash
command claude plugin validate ./dp-dashboard-prototype --strict
tsc -p ./dp-dashboard-prototype      # 加载过一次后才有生成的 tsconfig
```

`captures/` 里是在 herdr + iTerm2 里抓的屏幕：`*.txt` 是纯文本，`*.ansi` 带颜色。不要提交加载时自动生成的 `tsconfig.json`。
