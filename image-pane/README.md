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

- 图片字节不进 `$.state`：解码后写到 `/tmp/image-pane/<sessionId>/<n>.png`，界面让终端自己读这个文件。非 PNG（JPEG、WebP、GIF）用 macOS 的 `sips` 转成 PNG；别的系统上只能显示 PNG，其余只留文字条目。
- 每会话最多保留 200 张，重复的图（同一张截图再读一次）只收一次。

## 运行

```bash
claude --plugin-dir ./image-pane
claude plugin install image-pane@alex-mods --scope user
```

测试时的 Claude Code 版本：2.1.309（Desktop 自带的 2.1.308 上 validate 通过）。
