# image-pane

在终端右侧的停靠栏里显示本会话里的图片：

- **你发给 agent 的图**：每轮开始时，从你那条消息里取出。
- **agent 拿到的图**：任何工具结果里带的图，包括 Read 读的图片文件、截图工具（computer-use、浏览器、MCP 截图）返回的图，以及其他工具返回的图。子 agent 的图也收，并标出是哪个子 agent。

每张图会标出序号、来源、工具名和时间。`h` / `l` 翻上一张和下一张，`f` 回到"跟随最新"。按 `o` 或"打开原图"按钮（图片本身点不了：Image 元素不接受点击）用系统默认程序打开原图：Read 读的文件、你贴图时 Claude Code 存的原文件，找不到这些时打开 mod 保存的未缩小原件。`/images` 打开这个栏。

## 只在终端里工作

- 图片用终端图形协议画出：kitty、Ghostty、iTerm2 3.5 以上（全屏渲染）能显示真实像素（以 PNG 字节送出，超过 2 MiB 先缩小，因为 iTerm2 不认文件路径），其他终端和 tmux 只显示一行文字说明。
- 终端为全屏布局、宽度不少于 110 列时，栏停靠在对话右侧；否则出现在输入框上方。
- **Claude Desktop 不会做任何事**：mod 的安装分不出 CLI 和 Desktop（两边读同一份用户级插件），所以改为运行时判断：会话开始时没有终端（Desktop、`-p`、SDK）就什么都不注册、不收图；Desktop 的界面里也不画这个栏。

## 实现说明

- 显示用的 PNG 优先从原文件做（Read 读的文件、你贴图时的原文件）：引擎放进对话的那份已缩小，贴图还会重编码成 JPEG，透明背景会丢。原文件读不到、不是图片，或一次收到多张对不上来源时，回退到引擎那份。
- 工具结果的图从对话的行里收（`session.append`：回复行里的 `tool_use` 给出工具名和参数，随后的 tool-result 行给出结果），不挂 `tool.call`，所以可以和 Claude Code 的 Code Mode 一起用（0.2.0；Code Mode 不和挂 `tool.call` 的 mod 一起开）。行没经过 hook 的结果（mod 中途才加载）在下一步发请求前（`turn.step`）从对话里的 `tool_result` 收，按 `tool_use_id` 不重复收。Code Mode 下脚本里读的图不进对话（结果留在脚本里），收不到，除非脚本把图作为结果返回。
- 图片字节不进 `$.state`：解码后写到 `/tmp/image-pane/<sessionId>/<n>.png`，界面让终端自己读这个文件。非 PNG（JPEG、WebP、GIF）用 macOS 的 `sips` 转成 PNG；别的系统上只能显示 PNG，其余只留文字条目。
- 图按原比例显示要知道终端一格的高宽比，默认 2.125（iTerm2 的 Hack 14pt 实测 8×17 point）。换了字体或行距就在 `/config` 里改 `cellAspect`：在终端里运行 `printf '\e[16t'; read -rs -t1 -d t r; printf '%q\n' "$r"`，回报 `6;高;宽`，高除以宽即是。窗口大小、全屏与否和 herdr 都不影响它。
- 每会话最多保留 200 张，重复的图（同一张截图再读一次）只收一次。

## 运行

```bash
claude --plugin-dir ./image-pane
claude plugin install image-pane@alex-mods --scope user
```

测试时的 Claude Code 版本：0.2.0 是 2.1.325（只跑了测试、validate 和类型检查，没有在真实会话里看过图片栏）；更早的版本是 2.1.309；2.1.316 上测试、validate 和类型检查也通过（Desktop 自带的 2.1.309 上 validate 通过）。
