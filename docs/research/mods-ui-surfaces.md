# Mods 界面 surface 调研：终端与 Desktop 怎么画

日期 2026-10-05。Claude Code **2.1.289**（终端），Claude Desktop **2.19675.0**（内置引擎 2.1.286）。

标注约定：**[文档]** 官方文档或类型明说；**[实测]** 本次亲眼见到（`claude plugin test`、tmux/pty、Desktop 内置引擎驱动）；**[代码]** 读 Desktop 渲染器源码得出，未见屏幕；**[推断]** 我们的推理；**[未验证]** 需在原型里亲眼确认。

缩写：

- `T:N` = `dispatch-pilot/.claude-plugin/types/claude-code/index.d.ts` 第 N 行（2.1.289）。
- `LIVE:N` = Desktop 实际加载的渲染器 `c95e4d2cf-Cxhyt6KW.js`（196,074 字节，从 CDN 取回）美化后的第 N 行。
- `SNAP:N` = Desktop 本地快照 `ion-dist` 的对应文件。
- `docs/` 页面均在 https://code.claude.com/docs/en/plugins/mods/ 下。

---

## 1. 结论

**一个 mod、一个 hooks 模块、每个组件一个 `ui.render` hook，同时服务终端和 Desktop。不需要写两个 mod，也不要注册两遍 `ui.render`。但需要写两层很薄的「皮肤」：共享一个数据模型和布局，再按 `e.surface` 换图形与交互部件。**

依据：

- 引擎对每个已连接的 surface 单独求值同一条 hook 链，`e.surface` 说明是谁在问。T:9825-9836：「Each surface's ask is its own evaluation, since a tree may hold an element only some surfaces draw (Svg, Client).」**[文档]**
- 实测：引擎处理 `ui_render` 时对远端 surface 跑的是同一条 `E1e.run({surface, component, requestId, viewport, props})`（`strings289.txt` 第 585931 行）。**[实测]**
- 官方 Token Weather 一棵 Box/Text 树同时出现在终端和 Desktop 的 Code 标签里（https://claude.dev/blog/getting-started-with-claude-code-mods/ 的 Desktop 演示）。**[文档]**

为什么一棵一模一样的树不够：

1. **图形不同**。Svg 只有 Desktop（及 vscode、mobile）；Raster、Image 只有终端。
2. **站点行为不同**。Desktop 的 band 没有引擎折叠；Desktop 不画 PromptHint；`$.ui.status` 在 Desktop 没有 ⚠。
3. **Desktop 页面比引擎更严**：一棵树必须少于 2000 个节点（引擎是 20000），Client 里只认 Box/Text/Svg/Button/Input/Select。
4. **Desktop 内置引擎是 2.1.286，不是 2.1.289**：没有 `ui.fault` 事件（注册它整个模块加载失败），`borderStyle` 只认命名清单，`Link` 只认 https。

推荐结构：

```
model            ← 由 turn.step、agent.spawn、workflow journal 汇总，存 $.state
layout(model, bodyColumns)   ← 只用 Box / Text / Button，两个 surface 共用
skin(e.surface)
  terminal: Raster 或方块字符做进度条；依赖引擎的 [-] 折叠
  desktop : Svg 做进度条和折线；自己的折叠 Button；role:'dismiss' 关闭
  其它    : return next(e)（vscode、mobile 实际不画）
```

所有元素都从 `$.ui.resolve(e)` 取，不手写 `{type:'Svg'}`。

对 owner 四条需求的落点：

| 需求 | 终端 | Desktop |
|---|---|---|
| 右下角固定可收起版面 | footer 右侧 `SessionMode` 摘要 + AbovePrompt band（引擎 `[-]`） | footer 条里的 `SessionMode` chip + `$.ui.status` 摘要；band 内自带折叠 Button |
| 实时读数 dashboard | band | band（max 12 行）或 Pane |
| 排查依据版面（按需） | 右侧 dock 的 Pane | 侧边 tile 的 Pane |
| 彩色编号 log | Pane 里分页窗口化的 Text 行 | 同一棵树，节点数控制在 2000 以内 |

**没有任何一个 surface 有「自由浮在右下角」的原语。** 这一点终端和 Desktop 一致（见 §6.1）。

Desktop 的实际屏幕样子**一次都没见过**，所有 Desktop 结论来自读渲染器代码和驱动内置引擎。下一步必须在真实 Desktop Code 标签里挂一个可见的探针 mod（§8）。

---

## 2. 各 surface 能画什么（矩阵）

图例：实 = 已实测；文 = 文档明说；码 = 读渲染器代码；推 = 推断；未 = 未验证；— = 不画。

| 组件 / 元素 | terminal | desktop | vscode | mobile |
|---|---|---|---|---|
| `$.ui.status` | 实：`⚠ plugin:` 前缀（警告色），一行，超长以 `…` 截断 | 码：plugin 名 caption + 灰色正文，右对齐在 composer 脚部条，无 ⚠，拥挤时 32ch 截断，`+N` 弹层「Plugin status lines」，仅本地会话 | 文：不画 | 文：不画 |
| `$.ui.toast` | 实：右上角堆叠，约 42 列，3 行，4 s，同插件间隔 2 s | 码：应用自带 info toast「plugin: text」，240 字符，默认 4000 ms，上限 60000 ms；屏幕位置未 | 文：不画 | 文：不画 |
| AbovePrompt band | 实：整宽，引擎 `[-]` 与 ctrl+x ctrl+a 折叠，「n more」滚动，maxRows 最多半屏 | 码：composer 上方，仅本地会话，maxRows 固定 12，`hasSurvey:false`，`view:{}`，无引擎折叠，`role:'dismiss'` 的 Button 变关闭 X，空闲时不可见 | 不raise | 不raise |
| Pane | 实：≥110 列且全屏时右侧 dock，否则 inline（框线加 ✕） | 码：侧边 tile，`placement:'dock'`，多个时「Plugin panes」标签，占位「Nothing to show yet」，Esc 关闭（`closeOnEscape`）；窗口哪一侧未 | 引擎 raise，应用不画（文） | 同左 |
| SessionMode | 实：prompt 脚部最右的灰色标签 | 码：脚部条里的 inline chip，最宽 24ch，`modes` 传 `[]`，Text 样式保留，Button 变药丸，Box 拍平，Svg/Client/Input/Select 丢弃 | — | — |
| PromptHint | 实：脚部下一行；`tail` 仅终端 | **不画**：渲染器从不请求（live + 快照均无此组件） | — | — |
| Spinner | 文 | 码：请求 `word/message/suffix/mode`；树 inline 画一行高 | — | — |
| Box | 实：Ink flex；`borderStyle` 在 2.1.289 任意字符串、2.1.286 仅命名清单 | 码：shadow root 中的 flex div；padding/margin 横向 ch、纵向 0.5lh；border 为 1px CSS；absolute 被 site 裁剪（band 的 hover 卡片例外） | 引擎有表，应用不画 | 同左 |
| Text 样式 | 实：truecolor 精确；bold/italic/underline/strikethrough/inverse；dim = `rgb(102,102,102)` | 码：比例 sans；主题键 → CSS 变量；bold = semibold；dim = 60% color-mix | — | — |
| Button | 实：`[ label ]`，primary 用强调色，焦点内热键；`plain:true` 显示 `1: label` | 码：原生按钮 + 键帽提示，primary/secondary，`role:'dismiss'` 为关闭控件 | — | — |
| Input / Select | 文；kit 可挂载 | 码：输入框与自绘 listbox | — | 类型表中无 |
| Link / Code / Markdown | 文；kit | 文：Link 仅 https；**Client 内不可用** | — | — |
| Svg | **实：stub 画成空 Box；手写节点整棵树被拒** | 码：data URI 的 `<img>`，`isInteractive` 时 `sandbox=""` iframe；DOMPurify 清洗；≤131072 字符；宽高 ≤4096 px | — | — |
| Raster / Image | 实：Raster 在 tmux 画出渐变；Image 需 kitty/Ghostty | 实：table stub 为空 Box，手写节点被拒 | — | — |
| Client | 实（kit）：单元格区域，帧时钟、键、指针 | 码：沙箱双层 iframe + 严格 CSP；页面只认 Box/Text/Svg/Button/Input/Select；<2000 节点 | 无 | 无 |
| `$.ui.log` | 实：灰色「● plugin:」转录行 | 码：转录里的 `hook_notice` 行，空白被压平 | — | — |

来源：T:3692-3767（元素表）、T:9240-9814（各站点「Raised on …」）、docs/overview 的「Where mods run」表、`probe-ui` 17 个测试（`command claude plugin test`，17 pass / 0 fail，输出 `scratchpad/verify/rerun289.txt`）、tmux/pty 捕获、LIVE 行号见各节。

**vscode 与 mobile**：引擎表里有，应用不画。docs/overview：「The VS Code extension's chat panel | Yes | No」，Remote Control「Yes, in the session on your machine | In the terminal on your machine」。**[文档]** 本机没装 VS Code 扩展，无法检查。对 dispatch-pilot 来说这两个都不是绘制目标，hook 照常运行，`return next(e)` 即可。**[推断]**

---

## 3. 组件逐个说明

### 3.1 `$.ui.status`

- API：`$.ui.status(text|undefined)`，一个插件一行，纯字符串，没有颜色和结构，也没有 surface 参数（T:2364-2375）。**[文档]**
- 终端：引擎在 prompt 下一行加 `⚠ <plugin>:` 前缀，警告色，超长以 `…` 结尾。实测 `⚠ probe-live: probe status 状态栏 wide`；100 列下 200 字符的 status 被截成 `…0123456789 0…`。**[实测]** 前缀是引擎画的，不是 prop，去不掉（owner 已查过，关不掉）。
- Desktop：plugin 名 caption + 灰色 footnote 正文，右对齐（`flex-1 justify-end`）在 composer 脚部条、紧挨末尾的 Model/Effort 控件之前；拥挤时每条 32ch，其余折进 `+N` 弹层。**无图标、无 ⚠。** 仅本地会话。（LIVE:8626-8685、8700-8740、8839-8853；SNAP `cc70f2bdf-oAbIMYEh.js:16796-16868`）**[代码]**
- 传输：引擎发 `system/ui_status {plugin,text|null}`，Desktop 主进程压平制表符与换行、trim、限 4096 字符，每个插件保留最新一行。中文原样通过（探针：`probe status 中文 line`）。**[实测]**
- 结论：status 只做**一行极简摘要**，不放丰富内容。⚠ 只存在于终端。

### 3.2 `$.ui.toast`

- 终端：右上角堆叠框，标题是插件名，约 42 列换行，最多 3 行，点击移除，4000 ms。引擎对同一插件 2000 ms 内的第二个 toast 直接丢弃（debug 日志 `within 2000ms of the last; dropped`）。**[实测]**
- Desktop：变成应用自带的 info toast，内容「plugin: text」，文本截 240 字符，默认 4000 ms，上限 60000 ms（LIVE:7910-7927、8066-8074）。**[代码]** 屏幕位置**[未验证]**。`holdToasts` 在这个版本里被解析但未使用（desktop-app 报告，LIVE 行 593 附近）。
- 用法：只做瞬时事件提示（例如「路由失败」），不承载数据。

### 3.3 AbovePrompt band

- 位置：composer 正上方，所有 mod 共用一个槽。hook 返回的树会替换其后 mod 画的内容，要保留就把 `await next(e)` 放进自己的 Box 里（docs/interface）。**[文档]**
- props：`hasSurvey, isWorking, maxRows, bodyColumns, scroll, view`（读 `e.props.*`，不是 `e.*`；2.1.289 里顶层读法已失效，playground 示例因此出错）。**[实测]**
- **终端**：引擎在树右边加 `[-]`，树下加「↓ N more」；人用 ctrl+x ctrl+a 或点击折叠，实测折叠后显示 `▸ plugin panel hidden · ctrl+x ctrl+a or click to show`。maxRows = 底部槽剩余高度，最多半屏。`bodyColumns` = 列宽减引擎的 5。**[实测]**
- **Desktop**：
  - 仅本地会话且面板为活动面板。
  - props 固定 `{hasSurvey:false, isWorking, maxRows:12, bodyColumns, scroll, view:{}}`。
  - **没有折叠控件。** `role:'dismiss'` 的 Button 被提升为关闭 X。
  - 空闲时不可见、零高度。
  - hover 卡片被抬到顶层。
  - （LIVE:9780-9816、9857-9905）**[代码]**
- 要在 Desktop 上折叠，只能自己做：`$.state` 里放 `collapsed` 标志，一个 Button 的 `onPress` 用 `update($, atom, fn)` 翻转，hook 读 `read($, atom)` 后返回短树。T 说明插件没有「折叠 band」的 API。**[推断]**
- 带 `view.agentId`：人在任务列表里点开某个 agent 的转录时，band 会带着该 agent 重绘（T:9750-9758），可用来显示被查看 agent 的模型和 effort。**[文档]**

### 3.4 Pane

- API：`$.ui.open({id,title,focus,closeOnEscape,holdToasts,rows,columns})` → `{isPlaced:true}` 或 `{isPlaced:false, reason}`；`$.ui.close`、`$.ui.panes()`；渲染用 `ui.render {component:'Pane', requestId:id}`（T:2376-2425、7048-7128）。**[文档]**
- **终端**：全屏（alternate screen）布局且 ≥110 列时 dock 在 **右侧**（docs/interface：「a sidebar on the right」；实测 170 列 `bodyColumns=75`，150 列 66），高度顶天立地；否则 inline 在 prompt 上方，带框和 ✕（100 列实测 `bodyRows=4`）。人主动打开的任何宽度都放；插件**未经请求**打开的，宽度不足 144 列就先不画（打开过一次的 id 门槛降到 110）。**[实测 + 文档]**
- 终端 Pane **没有折叠**，只有关闭（引擎 ✕ 或 ctrl+x x，`ui.close` origin `person`，hook 可拒绝）。要折叠同样自建。**[文档 + 推断]**
- **Desktop**：
  - 侧边 tile，永远 `placement:'dock'`。
  - 多个 pane 时顶部出现「Plugin panes」标签；有关闭控件；`closeOnEscape` 时 Esc 关闭。
  - 占位文案「Nothing to show yet」。
  - pane 名单非空时 tile 自动打开，仅本地会话。
  - 实测：Desktop 内置引擎在 desktop surface 已 attach 时，`$.ui.open({id:'dash'})` 返回 `isPlaced:true`，推送 `ui_panes` 名单，`Pane` 渲染（含 `borderStyle:'round'`）被接受。
  - 窗口哪一侧、与用户自定义 tile 布局如何交互：**[未验证]**。
  - （LIVE:9935-9972、10270-10297、10000）
- 兜底：`isPlaced:false` 时同样内容改画在 band；注意被拒的 pane 仍是「打开但等待」状态，要记得 `$.ui.close`（playground 的 blast-radius 只在 placed 时关，有泄漏风险，T:13395-13398）。**[推断]**

### 3.5 SessionMode

- 终端：prompt 脚部最右的灰色模式标签，用「 & 」连接；hook 改写 `props.modes` 或画自己的树。实测 `Box` 包住 `await next(e)` 再加一个 Text，右端显示出 `probe-mode`。**[实测]**
- Desktop：脚部条里的 inline chip，**最宽 24ch** 省略，被截断时 tooltip 最多 300 字符；请求时 `modes` 固定传 `[]`（引擎的模式不传给 hook）；Box 拍平，Button 变小药丸，Svg/Client/Input/Select 丢弃（LIVE:7347-7406 附近，desktop-app 报告）。**[代码]**
- 角色：这是**唯一同时存在于两个 surface 的真正右下一行**。适合做一个极短的常驻摘要（例如 `dp 3 agent`）和折叠开关。

### 3.6 PromptHint

终端：脚部下一行；`tail` 只有终端画。**Desktop 不画**（渲染器从不请求，实测向内置引擎发 `ui_render PromptHint` 得到的是 `hooked:false`）。类型与文档表里写的 Terminal+Desktop 只是引擎侧。**不要依赖它。**

### 3.7 Spinner

终端和 Desktop 都 raise；Desktop 上是「承载本轮标记的那一行」，请求时带 `word, message, suffix, mode`。`requestId` 是 agent id（T:9201-9205），因此可能每个子 agent 一条。是否对 Workflow agent 也 raise：**[未验证]**。耗时、token、effort 都不是 prop。

### 3.8 转录行与 CommandOutput

`UserMessage, AssistantMessage, ToolUse, ToolResult, ToolGroup, CommandOutput, AskUserQuestion` 在引擎侧「Raised on every surface」（T:9240-9491），Desktop 渲染器也请求全部 7 个。`CommandOutput` 的 hook 可以返回自己的树，画在那一行的位置、转录的宽度（T:9483-9491）。**[文档]** 因此 `/dp log` 这类按需视图可以返回一棵 Code/Text 树，成为终端与 Desktop 通用的「排查依据」视图。**[推断]** 注意：命令的 `text` 是模型也会读到的那一行，别把整份 log 塞进去；详细内容从 `$.state` 画。（reference.md:105）

### 3.9 只在终端的站点

`ToolProgress`（后台任务药丸）、`TurnDuration`、`InfoNotice` 只在终端（T:9535、9597、9625）。

---

## 4. 元素与样式

### 4.1 Box / Text

- Box：`flexDirection, flexGrow/Shrink/Wrap, alignItems, alignSelf, justifyContent, gap*, width/height/min*, margin*, padding*, borderStyle, borderColor, borderDimColor, backgroundColor, overflow, display, position(relative|absolute)+top/left/right/bottom, key, hover`（T:841-930）。**[文档]**
- Text：`color, backgroundColor, dimColor, bold, italic, underline, strikethrough, inverse, wrap(...), hover`（T:12011-12029）。
- **属性是白名单**：任何其它 prop（`fontWeight`, `style`, `zIndex`, `opacity`, `className`, `textAlign`, `fontSize`, `fontFamily`）整棵树被拒，引擎画自己的组件（探针 T3c，终端与 desktop 均如此）。**[实测]** 所以「字体粗细」只有 `bold` 和 `dimColor` 两档，没有字号和字体族。
- Box `width/height` 必须是数字或百分比字符串（`'40'` 被拒，`'50%'` 通过）。**[实测]**
- Text `wrap`：`wrap, end, middle, truncate, truncate-start, truncate-middle, truncate-end`。
- `hover`：带 `key` 的 Box 或 `scope` 构成 hover 组，覆盖样式由 surface 自己应用，不跑 hook。`display:'none'` + `hover:{display:'flex'}` 的 absolute Box 可做无往返的 tooltip 卡片（T:803-870）。Desktop 上 hover 卡片只在 band 里被抬到顶层，别处被 `contain:paint` 裁剪（LIVE:5785）。**[文档 + 代码]**
- `borderStyle`：2.1.289 不校验（`'bogus'` 通过）；Desktop 内置的 2.1.284/2.1.286 校验，合法值：`single, double, round, bold, singleDouble, doubleSingle, classic, arrow, default, dashed, quote`。**只用这 11 个**，否则在 Desktop 内置引擎上整棵树被拒。**[实测]**

### 4.2 颜色与主题

引擎校验只看字面，**不判断颜色是否真能画出来**：接受任意单词、主题键、任意长度 hex（含 `#gggggg`）、`rgb()`、`rgba()`、`ansi256()`、`hsl()`；拒绝含 `:` `;` `<` `>` 和 100 字符的串（探针 T4/T6b）。**[实测]**

各 surface 的实际解析：

| 写法 | 终端（实测，truecolor pty） | Desktop（代码） |
|---|---|---|
| 主题键 `claude, success, error, warning, permission, inactive, subtle, suggestion, planMode, autoAccept, skill, diffAdded, diffRemoved …` | 随主题解析（本次：claude 215;119;87，success 44;122;57，error 171;43;63，warning 150;108;30，permission 87;105;247） | 映射到应用 CSS 变量，**随明暗主题变化** |
| 16 个 ANSI 名（`red, green, cyan` …，可带 `Bright`、`ansi:` 前缀） | 解析为主题 RGB（green 70;167;88，cyan 5;162;194） | 固定 hex（green `#46a758`，cyan `#05a2c2`），**不随主题** |
| `#rgb / #rrggbb / #rrggbbaa`、`rgb()/rgba()/hsl()/hsla()` | 精确（`rgb(255,136,0)` → `38;2;255;136;0`） | 原样通过 |
| `ansi256(208)`、`orange` 等其它 | `ansi256(208)` → `38;5;208`；`orange` 未验证 | **变成 `currentColor`，静默无色** |
| `dimColor` | `rgb(102,102,102)`，不是 SGR 2 | 60% color-mix |
| `bold` | SGR 1 | semibold |

（终端：pty 抓取 `scratchpad/live-raw.bin`，170x52；Desktop：LIVE:2539-2664。）

**两边都可靠的颜色**：主题键、16 个 ANSI 名、hex、`rgb()`。避免 `ansi256()` 和自造颜色名。tmux 里 `rgb()` 会被量化到 256 色（`38;5;214`），判断色彩保真请用带 `COLORTERM=truecolor` 的 pty，不要看 tmux 截图。**[实测]**

Svg 颜色：Desktop 在引擎槽里的 Svg 会被注入宿主文字颜色和字体，`currentColor` 能跟主题；**Client 里的 Svg 不注入**，`currentColor` 是否跟主题**[未验证]**。George Liu 的 Desktop mod 用半透明灰做轨道以同时适配明暗（https://ai.georgeliu.com/p/claude-code-mod-desktop-statusline：「a translucent grey track that reads on light and dark themes」）。**[文档]**

### 4.3 Button / Input / Select / Link / Code / Markdown

- Button：`key, label, hotkey(一位数字或小写字母), action, plain, dimColor, variant, role:'dismiss', autoFocus, hover, onPress`（T:1000-1092）。`hotkey` 传 `'W'`、`'ab'`、`'?'` 会让表构造函数抛错，hook 失败，引擎画自己的（探针 T9）。**[实测]** 热键仅在站点持有焦点时触发；在 band 里，输入框为空时单独敲该数字并停顿也会触发（reference 脚注）。
- Input/Select：终端、Desktop、vscode 有，mobile 没有。焦点环只存在于 Pane 和 band 里。Input 提交不会开始一轮，除非回调里调 `$.prompt.submit`。**[文档]**
- Link：终端是 OSC 8；Desktop 只认 https（http 仅 localhost/127.0.0.1/[::1]）。2.1.289 接受任意 href，终端保留 Link，desktop 把非 https 降为纯 Text；**2.1.286 则整棵树被拒**。**[实测]**
- Code：引擎高亮器的颜色，不由插件控制；`startLine` 打开右对齐灰色行号栏；`format:'diff'` 读 unified diff；≤10000 字符（T:1545-1601）。可做带行号的 log，但颜色是引擎的。**[文档]**
- Markdown：≤10000 字符；`onLinkPress` 走 `ui.press`。

### 4.4 Svg（只有 Desktop，「最高级画法」之一）

- 属性：`source`（≤131072 字符）、`alt`（必填）、`width/height`（CSS px，Desktop 页面上限 4096）、`isInteractive`（T:11712-11747）。**[文档]**
- 默认画成图片；`isInteractive:true` 画在无脚本沙箱 iframe 里，使 `:hover`、SMIL 动画和 `<title>` tooltip 可用。标记经 DOMPurify 清洗，`script`、`foreignObject`、`image`、`a`、`iframe` 被禁，外部 href 被丢（LIVE:3766-3811）。**[代码]**
- 是叶子：点击要放在外层 Button 上。
- 终端的行为（实测）：
  - 经 `$.ui.resolve(e)` 取到的 `Svg` 是 stub，调用得到一个空 column Box，树的其余部分照常画。
  - 手写 `{type:'Svg'}` 则整棵树被拒：`refused: Svg is not an element of the terminal surface; the engine drew its own`。
  - 因此 `t.Svg ? … : …` 这类守卫**永远不会走到 else**，必须判断 `e.surface`。
- 为什么要用：George Liu 的 Desktop mod 因 Desktop 字体把 `░` 画成斜线填充方块，改用 Svg 做进度条。**[文档]** 另外 Desktop 没有像素宽度，作者实测约 12.5 px/列、15 px/格、13 px/字符（随字号变化），Svg 宽度只能估算。**[文档，推断可借鉴]**

### 4.5 Raster / Image（只有终端）

- Raster：`columns≤512, rows≤256`，`cells` 是 base64 的 `[codePoint, fg, bg]` u32 三元组，每个码点必须是单个可打印宽度 1 的 BMP 字符，颜色 `0x00RRGGBB`，一次最多 1024 个不同颜色对；`$.ui.blit` 原位重画（每秒最多取 120，约显示 60）（T:8738-8773、2278-2298）。实测 24 格渐变画成彩色 `▀`。**[实测]**
- Image：PNG/RGBA/文件/shm，≤2 MiB，只在 kitty、Ghostty 这类终端有像素，其余显示 `alt`（T:5114-5151）。
- 这是终端上能做到的「最高级」图形：一个 Raster 做折线图或热力图，不要用一个 Box 一格。

### 4.6 Client（终端与 Desktop 共有，但各有限制）

- 是插件自己的 surface 模块（字符串字面量路径）画的区域：无 `$`，有本地 `setState`、`every(ms)` 帧时钟、`onPointer`、`onKey`，`post(data)` 通过 `ui.message` 回到 hooks 模块（T:1426-1532）。**[文档]**
- 引擎契约：`ClientElements = Omit<Elements['terminal'],'Client'|'Raster'|'Image'>`，即 Box/Text/Button/Input/Select/Link/Code/Markdown，没有 Svg（T:1328-1336）。
- Desktop 页面的实际 schema 更窄：只认 Box/Text/div/span/b、Svg（宽高必填）、Button `{key,label,plain}`、Input、Select；**Link/Code/Markdown 会让页面判实例故障**：`returned a tree the page cannot draw`（LIVE:339、4208-4251、4521-4528）。**[代码]**
- **两边都安全的集合只有 Box、Text、Button、Input、Select。**
- Desktop 的 Client 树限制：<2000 节点、深度 <32、<262144 字符；消息洪泛保护 400 条/秒；≤32 个定时器（≥16 ms）。**[代码]**
- 2.1.289 修复：失败的 Client 单独失败并触发 `ui.fault`，不再拖垮周围内容（changelog 2.1.289）。**但 Desktop 内置 2.1.286 没有 `ui.fault`**，在 hooks 里 `on('ui.fault')` 会让整个模块加载失败（实测）。所以要在 Desktop 上跑，**不能注册 `ui.fault`**，或把它放在版本检测之后（模块加载是静态检查，实际上做不到；建议先不用 Client，见 §6）。
- 不要在一个 Client 里手写 Svg/Raster；终端会拒绝，Desktop 对 Raster 也拒绝。
- 终端指针只在全屏布局下有；Client 键盘事件只有点击给了焦点之后才到，Esc 把焦点还给 prompt（T:1338-1354、1519-1522）。

### 4.7 树的大小上限

| | 引擎 | Desktop 页面 |
|---|---|---|
| 节点数 | 20000 | **<2000** |
| 深度 | 32 | <32 |
| 序列化字符 | 100000 | <262144 |

Desktop 页面在节点数不满足时丢弃整个 `ui_render` 答案，然后画引擎默认（LIVE:318-322、519-523）。**测试 kit 只按引擎上限校验，抓不到 Desktop 的 2000 限制**（探针 T3b：19990 节点在终端被拒，100 通过）。所以 log 视图必须窗口化。**[代码 + 实测]**

---

## 5. 中文与双宽字符

- **引擎校验不限制宽度。** CJK、全角拉丁、emoji、ZWJ emoji、方块字符、盲文在四个 surface 全部通过（探针 T3）。拒绝的只有 ESC/BEL 等控制字符、单个文本子节点 >10000 字符；孤立代理项被替换为 U+FFFD。**[实测]**
- **终端画对双宽。** 在 `width=30`、双线边框的 Box 里，一行 `wrap="truncate-end"` 的中文被 `…` 截断，右边框保持对齐（宽字符放不下时补一个空格）。实测输出 `║排查依据：为什么没有路由到… ║`；Pane、band、status、toast 里的中文都正常。**[实测]**
- **Desktop 没有格子计量。** 文本是 sans 比例字体的 HTML，中文直接渲染、CSS 换行；只有含方块/制表字符（U+2500-259F）或空格对齐的列的行才切到 mono 并关连字（LIVE:5324-5382、6148）。**[代码]** 推论：Desktop 上不要靠填充空格对齐中文，用 Box 宽度（ch）；CJK 在 mono 回退字体里不一定正好 2 格宽。**[推断，未验证]**
- Desktop 对 status/toast 文本的清洗：制表/换行/U+2028/2029 → 空格；C0 控制字符 → 控制图片符（U+2400+n）；格式字符与默认可忽略字符（含 **U+2800 盲文空白**、U+FFFC）→ U+FFFD；ZWJ、ZWNJ、VS15/16 保留；上限 4096 字符加 `…`（app.asar `index.chunk-DPWtnchX.js` 函数 `Z`）。**所以 status/toast 里别放换行和 U+2800，但中文是安全的**，ASCII-only 的回退并非必需（纠正了一份报告的建议）。**[实测]**
- 已知终端宽度坑（GitHub issues #26084、#59008、#84986、#59952）：VS16 emoji 序列（如 U+27A1 U+FE0F）曾被算成 1 列；东亚模糊宽度字符（`▲▼▶◀·…` 和 `▁▂▃▄▅▆▇█`）在 CJK 配置的终端里可能画成 2 格。要对齐的行避免这些，按 `bodyColumns` 截断。**[文档，部分推断]** 注意：Raster 单元仍然要求单宽度字符，与普通 Text 是两回事。
- **仓库规则**：根 `CLAUDE.md` 里「界面里用单宽字符，不要用 emoji」来自教程建议（「Use single-width symbols, not emoji」），不是引擎限制。owner 已要求划掉；引擎和 Desktop 都不要求 ASCII。`dispatch-pilot/hooks/core/status.ts:4-6` 的「ASCII-only」注释也源于此，可随重构去掉。（修改 `CLAUDE.md` 不在本次调研范围，只记录。）**[观察]**

---

## 6. owner 需求逐条映射

### 6.1 右下角固定、可收起/折叠的版面

事实：**没有悬浮在右下角的原语。**

- 没有哪个站点是浮层。`position:'absolute'` 的 Box 被其所在站点（viewport、pane、band）裁剪，不能浮在转录上（T:864-866）。**[文档]**
- 官方 docs/interface 列出的位置：右侧 Pane、右上角 toast、转录里的日志行、prompt 上方的 band、prompt 下方的 status 行。
- 终端的 `● high · /effort` 引擎标签已经占着右下上方，不属于任何 render site，不可改（Anthropic 博客截图）。**[观察]**

可行做法（两个 surface 同一思路，分三层）：

1. **常驻摘要（右下）**：`SessionMode` 一两个词（终端是脚部最右；Desktop 是脚部条里最宽 24ch 的 chip，可放 Button 药丸作折叠开关）+ `$.ui.status` 一行（Desktop 也在脚部条右侧，终端在 prompt 下）。
2. **展开的版面**：band（终端用引擎 `[-]`；Desktop 用自己的折叠 Button + `$.state`）。在 band 内用 `justifyContent:'flex-end'` + `width=bodyColumns` 把内容贴右，可得「看上去在右下」的效果（参考 `jev-pet.tsx:384`，`justifyContent="flex-end" … width={columns} paddingRight={4}`）。**[实测/观察]**
3. **按需详情**：Pane，终端右侧 dock、Desktop 侧边 tile。

限制：Desktop 的 band 没有引擎折叠；终端 Pane 没有折叠；折叠状态都要自己存 `$.state`（热重载会重置模块变量，T 的 `$.state` 章节）。

### 6.2 实时读数 dashboard（主 agent effort、每个派出 agent 与 Workflow agent 的模型和 effort、skill 建议）

数据来源，**不要用 `$.agent.list()`**：

- `$.agent.list()` 返回 `AgentInfo {id, teammateId?, description, type, status, parentId?, spawnedBy?, name?}`，**没有 model 和 effort**；「A workflow's agents and the engine's own forks (compaction, memory) carry ids no list names」（T:121-206）。**[文档]**
- 用 `turn.step`（每次模型请求前，带 `model`、`effort?`、`agentId?`）和 `agent.spawn`（`model`、`parentModel`）汇总成自己的表，以 `agentId` 为键，存 `$.state`（T:12768-12811、253-356；`dispatch-pilot/DEVELOPMENT.md:997-1008`：Workflow agent 的第一个 `turn.step` 在 Workflow `tool.call` 返回约 16 ms 后出现，journal 每个 agent 一条 `started`）。**[文档 + 观察]**
- `turn.step` 对 Workflow agent 是否一定触发并带 effort：DEVELOPMENT.md 的观察支持，但类型文档没明说。**[未验证，见 §8]**

画法：

- 版面：band（读数卡片：一行一个 agent，`模型 · effort · 状态`，彩色）。Desktop 上节点数 <2000 不是问题；超过 12 行时终端靠引擎滚动，Desktop 靠 band 自身滚动。
- 终端图形：一个 Raster 做 context 占用条/折线；Desktop：Svg 进度条和 sparkline。
- 刷新：`$.ui.invalidate('ui.render')` 每秒最多 10 次（终端可见 Pane/展开 band 30 次）；`ui.render` 里读 `read($, atom)` 的 hook 在状态写入时会自动重画。
- Desktop 脚部条已经有 Model 和 Effort 控件（SNAP:16810-16831），那只是**主 agent**，没有子 agent 读数，所以 dashboard 才有价值。**[代码]**
- 注意：Desktop 在会话开始之后才 attach，要在 `session.attach` 时也刷新（T:10152-10175）。**[文档]**

### 6.3 按需的排查依据版面（为什么这样决定、为什么没路由）

- 用 Pane（终端 dock 右侧；Desktop 侧边 tile），由 `/dp why` 之类的命令用 `$.ui.open` 打开，才算「人主动打开」，在任何宽度都放（T:2380-2385、13373-13383）。
- 兜底：`isPlaced:false` 时改在 band 画同一视图，且别忘记 `$.ui.close`。
- 另一条路：`CommandOutput` 返回树，成为转录里的一行（所有 surface，持久留在转录里），适合「一次性导出」。
- D 选项「不说明原因」的问题由这里解决：每条决策存一个 `{原因码, 中文说明}`，Pane 里按条展示。

### 6.4 彩色、粗细、编号的 log

- 终端和 Desktop 都能：每行一个 `Box flexDirection:'row'`，编号 `Text color:'subtle' dimColor`，级别徽标 `Text bold color:成功/错误/警告`，正文普通，原因 `dimColor`。
- 没有「编号列表」元素：编号要自己写字符（`01`、`02`）；或用 `Code` 的 `startLine` 行号栏（颜色是引擎的）；或 Markdown 有序列表（T:1577-1583、5502-5540）。**[文档]**
- **窗口化**：Desktop 页面要求 <2000 节点，且 Code/Markdown 单元 ≤10000 字符；按 `e.props.scroll.bodyRows` 或自己的页码只画当前页（reference 的 `ui.scroll` 钩子可接管滚动，`$.ui.scroll({to:'end'})` 可做跟尾）。**[文档 + 推断]**
- Pane 和 band 内树超过窗口时引擎自动滚动；键盘 Up/Down/PageUp/PageDown/Home/End 在焦点内可用。**[文档]**
- 字符不受限：中文、`●▸✘✔`、方块字符都可以；只要避开 Desktop 清洗会改写的 U+2800 与控制字符，以及要对齐的 VS16 emoji。终端上若必须对齐，用 Box 固定宽度加 `wrap:'truncate-end'`。

### 6.5 Desktop 可用

- 条件：Code 标签、**本地会话**（band、脚部条、Pane 都以 `sessionRef.type==='local'` 为前提；SSH/远程会话算不算本地**[未验证]**）；WSL 会话不加载任何插件（docs/overview、Desktop doc）。**[文档]**
- dispatch-pilot 在 Desktop 内置引擎 2.1.286 上能加载：实测用 stream-json 按 Desktop 的方式（setting sources user/project/local，无 `--plugin-dir`）启动，debug 日志 `hooks module dispatch-pilot@alex-mods loaded (worker, environment 1, tier user)`，capabilities `["ui_surface_v1"]`。**[实测]** 因此**现有的单行 `$.ui.status` 在 Desktop 上已经会显示**（plugin 名 + 文本，无三角形），只是没在屏幕上见到。**[实测机制 + 代码，屏幕未见]**
- 兼容基线：按 **2.1.286** 写。不注册 `ui.fault`；`borderStyle` 用命名清单；`Link` 用 https。
- 工作量：不用另写 UI 框架；`layout()` 共用，`skin()` 两份。

---

## 7. 测试：用 `$.ui.mount` 按 surface 测

- `$.ui.mount({plugin, surface, component, props, requestId?, viewport?})` 通过插件在指定 surface 上画一个组件实例，返回句柄；`surface` 从不默认，一个测试体可对 `['terminal','desktop','vscode','mobile']` 循环（T:14310-14336、15005-15052；docs/test：「To cover several apps in one test, set surface to the app to draw for.」）。**[文档]**
- 句柄：`drawn`, `find/findAll({type,key,text,in})`, `press`, `input`, `select`, `key`, `pointer`, `post`, `advance(ms)`, `resize`, `redraw`, `unmount`（`key/pointer/post/advance/resize` 仅在有 Client 的 surface 可用；`input/select` mobile 无）。
- 它校验的是**引擎规则下的树**，不是 Desktop 页面的绘制：
  - 一个 surface 上没有的元素或不允许的 prop 会被拒（附原因）。
  - `$.ui.mount` 能把任何组件挂到任何 surface，**测不出该 surface 是否真的 raise 该组件**（探针 T1：8 个组件 x 4 个 surface = 32 个全 OK）。所以「Desktop 不画 PromptHint」这类事实不能靠 mount 验证。**[实测]**
  - **抓不到** Desktop 的 2000 节点上限、Client 的 Link/Code/Markdown 限制、颜色 `ansi256` 变 `currentColor`、2.1.286 的 `borderStyle` 与 Link 校验。需要各自写断言：自己数节点，自己限制颜色集合。
- 测试里 `next(e)` 会报 `no implementation for ui.render`，除非注册底层 hook；`$.ui.open`、`$.ui.panes`、`$.session.surfaces`、`$.ui.copy` 同样需要在测试里提供底层答案（探针 T8c）。**[实测]**
- 建议：
  1. 每个组件一个 `for (const surface of ['terminal','desktop'] as const)` 循环；
  2. 对 `layout()` 写纯函数测试（stub 元素），对 `skin()` 用 mount；
  3. 另跑一遍 Desktop 内置引擎：`command claude plugin test` 用 2.1.286 的二进制（路径 `~/Library/Application Support/Claude/claude-code/2.1.286/f2326db61802/claude.app/Contents/MacOS/claude`）。探针里 2.1.289 与 2.1.286 的结果只在三处不同：T5 `borderStyle`、T9 `linkhref`、`ui.fault` 事件。**[实测]**
  4. 注意 `command claude`，别用带参数的 alias。

---

## 8. 未验证、需要在原型里亲眼确认的事项

最优先（Desktop 实机）：

1. **Desktop 零像素证据。** 每个 desktop 单元都来自读渲染器代码与驱动引擎。需要一个可见探针 mod 在真实 Desktop Code 标签里同时画：band、Pane tile、脚部条（status + SessionMode chip）、Svg、中文、明暗两种主题。
2. **Pane tile 在窗口哪一侧**，与用户自定义 tile 布局的交互（`setSidePane` key `'plugin'`）；Desktop info toast 的屏幕位置。
3. **Desktop 本机的 dispatch-pilot 真实 status 显示**（机制与加载都已观察，但没跑 prompt，屏幕没见）。
4. **每个 Desktop Code 会话是否都上报 `isFullscreen:true`**，使 `$.ui.open` 返回 `isPlaced:true`；SSH/远程 Desktop 会话是否算 `local`。
5. **Workflow agent 的 `turn.step` / `tool.call` 是否带 `agentId`、`model`、`effort`**，以及 Spinner 是否对每个子 agent 和 Workflow agent 以 `requestId = agent id` raise（决定能否把每 agent 的标签放进转录 Spinner）。

其他：

6. Desktop 的 live 渲染器是否在 10-04 之后又变（claude.ai 现在对 curl 返回 403，无法列出当前部署）。我分析的是 Desktop 上次加载的 `c95e4d2cf-Cxhyt6KW.js`。
7. Desktop 内置引擎何时升到 2.1.287+（目前 main.log 先 2.1.284 后 2.1.286，与应用构建绑定）；在此之前 `ui.fault` 不可用。
8. Client 内 Svg 的 `currentColor` 是否随主题；Client 的 Svg 在 Desktop 页面可用但引擎契约不含 Svg，终端会拒绝。
9. 终端 SessionMode 里的 Button 能否被点击/按（焦点环只在 Pane 和 band 里）；终端 Spinner 与 Input 未亲眼绘制。
10. `$.ui.copy` 在 Desktop：类型自相矛盾（T:2463 与 T:13021），Desktop 看到了 `ui_copy` 宿主处理器但没演练。
11. Desktop 空格对齐的 CJK 列（会切到 mono，而 mono 回退字体里中文未必正好 2 格）。
12. 终端上 `orange`、`hsl()` 的实际着色（校验接受，着色未查）。
13. 同一 band 与别的 mod 的共存（不包 `await next(e)` 会互相覆盖）。
14. VS Code 扩展的实际行为（未安装，文档说不画）。

---

## 9. 来源

官方文档与博客：

- https://code.claude.com/docs/en/plugins/mods/overview （「Where mods run」表：「The Code tab of the Desktop app, except in a WSL session | Yes | Yes, except elements the elements table marks terminal-only」；「Mods require Claude Code v2.1.287 or later」）
- https://code.claude.com/docs/en/plugins/mods/interface （「A mod can add a pane as a sidebar on the right, a toast at the top right of the transcript, a log line in the transcript, a band above the prompt, and a status line under the prompt.」）
- https://code.claude.com/docs/en/plugins/mods/api 、`/reference`、`/gallery`、`/test`
- https://code.claude.com/docs/en/changelog （2.1.289：Client 隔离、`ui.fault`、右对齐不再画到关闭标记下）
- https://code.claude.com/docs/en/desktop （「The Code tab is built around panes you can arrange in any layout」；「Plugins aren't available in WSL sessions.」）
- https://claude.com/blog/claude-code-mods （「Today, a mod can target the terminal, the desktop app, or both.」）
- https://claude.dev/blog/getting-started-with-claude-code-mods/ （「The elements aren't globals. $.ui.resolve(e) returns the constructors for the surface being drawn …」；Desktop 演示）
- https://github.com/anthropics/claude-code/issues/91870 （一个 `ui.press` hook 同时看到终端和 Desktop 的按钮）
- https://github.com/anthropics/claude-code-playground （`claude-code/mods`，3 个示例，均终端测试、无 `e.surface` 分支）

第三方：

- https://ai.georgeliu.com/p/claude-code-mod-desktop-statusline 与 https://github.com/centminmod/claude-plugins （Desktop band、Svg 进度条、`session.attach` 刷新）
- https://dev.to/reporails/claude-code-mods-minesweeper-and-testkit-3067 （Client 热键与焦点陷阱）

本地类型与引擎：

- `T` = `/Users/alexnear/Documents/claude-mods/dispatch-pilot/.claude-plugin/types/claude-code/index.d.ts`（15,197 行，2.1.289）
- `/private/tmp/claude-501/bundled-skills/2.1.289/fff685445fa4bacbb134ef5a97843ace/plugin-authoring/`（`reference.md`、类型）
- `strings289.txt`（2.1.289 二进制：`RENDER_SURFACES_OF` 表、`ui_render` 处理器、`ui_toast`/`ui_status` 事件，行 585930-585931）、`cli-2.1.286.strings`（Desktop 内置引擎：`tengu_plugin_hooks_modules` 默认 true，行 326855）
- `/Users/alexnear/Documents/claude-mods/dispatch-pilot/DEVELOPMENT.md:997-1013`、`dispatch-pilot/hooks/core/status.ts:4-6`

Desktop 应用：

- `/Applications/Claude.app/Contents/Resources/ion-dist/`（快照渲染器；注意 Grep 工具遇到含 NUL 字节的文件会跳过，要用 `tr -c '[:print:]' '\n' | grep -o AbovePrompt` 才能数到）与 app.asar（`index.chunk-DPWtnchX.js`、`mainView.js`、`index.chunk-F67n9SlO.js`）
- live 渲染器：`https://assets-proxy.anthropic.com/claude-ai/v2/assets/v1/c95e4d2cf-Cxhyt6KW.js`（200，196074 字节；通过 `~/Library/Application Support/Claude/Code Cache/js/431db68034996dd5_0` 找到入口 `cde6354a0-CgkKrJ53.js`）；本地副本 `scratchpad/verify/live/c95-live.pretty.js`
- `~/Library/Logs/Claude/main.log`（2026-10-04 05:24:47：`Using Claude Code binary at: …/claude-code/2.1.286/…`）

探针（scratchpad：`/private/tmp/claude-501/-Users-alexnear-Documents-claude-mods/0536ecd7-ea1e-4e50-bd79-7f304c0a52cd/scratchpad`）：

- `probe-ui/`（17 测试、9 个测试文件）：`command claude plugin test` 在 2.1.289 上 17 pass / 0 fail；2.1.286 与 2.1.284 对照 `results/v289.sorted` vs `results/v286.sorted`
- `verify/dp-desktop-load.mjs`（按 Desktop 方式启动 2.1.286，加载 dispatch-pilot）、`probe-driver*.mjs`（Desktop 内置引擎 ui_render/ui_status/ui_toast/ui_panes 驱动）
- `ptycap.py`（truecolor pty 抓取，170x52）与 tmux 捕获 `live-screen-*.ansi`

核对过程中被推翻的说法：

- 「Desktop 渲染器不在本地，claude.ai 的 616 个 chunk 里查无 AbovePrompt」：错，是 Grep 跳过含 NUL 的文件导致；字节级计数 4 次。
- 「PromptHint 在 Desktop 画」：不画。
- 「`$.ui.status` 总带 ⚠」：只在终端。
- 「AbovePrompt 只在终端」（playground README）：过期。
- 「Desktop 按像素排版、用代码字体」：文本用 sans，只有视口探针和含方块/列对齐的行用 mono。
- 「Mods 需要 2.1.287，所以 Desktop 2.1.286 不跑」：实际能跑，gate 默认 true。
