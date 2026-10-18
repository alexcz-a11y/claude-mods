# Dispatch Pilot：Desktop 上的界面按「点」来画，重画放慢，状态行让给 band

ADR 0011 把终端的 band、脚部和依据面板原样搬到了非终端端，只换了画法（Svg 代替 Raster，mono 和 tabular 对齐）。2026-10-18 第一次在真的 Desktop 上用（Desktop App 2.42304.0，自带 Claude Code 2.1.299，跑的是兼容版 0.8.0-desktop），看到三处问题：band 的「▾ 收起」几乎点不中；字符画、按键提示和一段段纯文字是终端的说法；同一份读数在 band、状态行和脚部标签上画了三遍。查下来，收起点不中的原因是重画：每次重画都给按钮换一个新 handle，Desktop 按下时带的是它正在显示的那棵树的 handle，中间被重画过，引擎就回 `handled: false`，这次按键没有任何效果。0.8.0 在 turn 运行时每 200 ms 重画一次。

决定如下。这些改动先在 Desktop 兼容版（0.8.0-desktop.1）上真机验收，再同样合进 main（0.8.1）；终端的画法不变：所有改动都在 `e.surface !== 'terminal'` 的分支里。兼容版为 2.1.299 去掉的东西（`prompt.change`、`$.ui.view` 的兜底）不随它进 main。

**重画放慢。** 非终端端在 turn 运行时每 5 秒（`SLOW_TICK_MS`）重画一次，不再是 200 ms。这些端不画转圈，运行中的状态符号是不动的 ●。运行中的时间色带画成可交互的 Svg，用 SMIL 动画自己长到下一帧的位置，时间轴也放宽到下一帧，所以两次重画之间色带照样在动，dp 不用为它重画。用时的数字每 5 秒变一次。

**按「点」来画。** band 上 agent 的名字是按钮，不带数字键。「0-9 选中」「/dp log 看依据」这类提示换成 band 自己的「依据」按钮，effort 写成彩色的字，不画 ▰▱。依据面板另画一份（`board/pane-app.tsx`）：一排 agent 标签代替 ‹ 上一个 / 下一个 ›；卡片的名字大一号，规则写成没有 ├ └ 的清单，概率的份额写在条下面一行；日志点轮次标题折叠，每条一行，其余（概率、skill、理由）用 hover 的 `scope` 在指着时显出；功能开关和 effort 锁定在面板最下面，开关是按钮，锁定是 Select，按下就改，和 `/dp` 改的一样存进 `$.store`。面板自己有「关闭」（`role: 'dismiss'`）；`/dp` 只在会话带终端时用 `focus` 打开，因为一个请求过焦点的面板，Desktop 会在它被藏起来时再显示出来。引擎没有 `$.ui.view`（2.1.300 之前）时不画「看它的对话」。

**状态行让给 band。** 会话里有 Desktop 时不写状态行（ADR 0011 原来的理由是 Desktop 的 band 空闲时会隐藏，但 2.1.299 上空闲时它照样画那一行）。状态行会把 prompt 往上推一行，读数也和 band、脚部标签重复。prompt 提示在 Desktop 上改写到 band 的空闲行上（`$.state` 的 `draftHint`，由 prompt-hint.ts 写，下一轮开始时清掉），没有终端也没有 Desktop 的会话（VS Code、手机）照旧用状态行。

考虑过的另一种修法是不放慢重画，而是让按钮的 handle 在重画之间保持不变。没有采用：handle 由引擎发，mod 管不了。

代价：2026-10-18 在 Desktop（2.1.299，兼容版）上点过一遍，收起、依据、面板的标签、日志折叠、开关和关闭都正常；main 版在 2.1.300 起的 Desktop 上还没看过。Desktop 的 next-step 卡片出现时 band 会被藏起来（anthropics/claude-code#102249），状态行停用后，这段时间只剩脚部标签。Desktop 是否发 `prompt.edit` 还不知道；如果不发，band 空闲行上的提示就不会出现。面板 × 关不掉的原因只是推测（焦点请求），还没证实。
