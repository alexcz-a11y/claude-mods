# Dispatch Pilot：不带终端的会话用状态行，非终端端的色带和概率条画成 Svg

ADR 0004 停用了 `$.ui.status`，理由出在终端上：那一行前面的 ⚠ 关不掉，一行放不下几个 agent，而且每个插件只能留一行。不带终端的会话情况不同。VS Code 不画 band，也不画脚部标签。Desktop 的 band 在会话空闲时整个隐藏，所以一轮结束后的那一行摘要（结果、「可试 /x」）在 Desktop 上从来看不到；Desktop 的 next-step 框出现时也会挡住 band（anthropics/claude-code#102480）。这两个端都把状态行画在 prompt 下面，没有 ⚠。

决定如下。

**状态行。** 会话的 surface 里没有 `terminal` 时（`$.session.surfaces()`），Dispatch Pilot 用状态行写 band 的一行摘要（`band.tsx` 的 `statusText`）：第几轮、主 agent 的模型·effort；一轮结束后加上这一档是怎么来的和「可试 /x」；最后是各状态 agent 的个数。prompt 提示（`prompt-hint`）在这时也写到这一行，用户写草稿时优先显示它，下一轮开始后换回摘要。只要会话里有终端（包括终端加手机的 Remote Control），就不写状态行，ADR 0004 在终端上的理由仍然成立。

状态行仍然只画「决定汇报」的数据，和 band 读同一份 `ScreenView`。设置它的 hook 只看不改，注册在最外层，所以一轮结束时读到的是 report 刚写好的看板。考虑过的另一种做法是在 `SessionMode` 的渲染 hook 里顺手设置状态行；没有采用，因为画的时候不该有副作用（ADR 0004 只在按键的 `onPress` 里写视图状态）。

**Svg。** 时间色带、概率条和置信条在终端上是 Raster，在有 Svg 的端（Desktop、VS Code、手机）画成小的 SVG。`kit.tsx` 的 `Marks` 把这两种画法收在一起，band 和面板不再关心是哪个端。一格宽度按 `CELL_PX`（7 px）算：Box 的宽度用的是 surface 自己的格宽，mod 读不到，所以宁可画得短一点，也不要超出格子。Svg 不接收 key，外面包一个带 key 的 Box。

**其他。** 字体方面，Desktop 的正文是比例字体，所以模型标签、pip、状态符号和用空格对齐的列用 `mono`，数字用 `tabular`；终端忽略这两个属性。折叠方面，终端的引擎自己会折叠 band，其他端在 band 上放一个「收起 / 展开」按钮，折叠状态存进 `$.state` 的 `bandFolded`，整个会话有效。按键方面，Desktop 会在按钮旁边自己画出按键，VS Code 和手机不接受按键，所以终端以外的端，依据面板的按钮文字不再写「(p)」。

代价：状态行和 Svg 在真实的 Desktop 上都还没亲眼看过。写这份 ADR 时，Desktop 自带的 Claude Code 是 2.1.299，加载不了 Dispatch Pilot，它需要 2.1.300。目前只用测试里扮演引擎的 world 和渲染出的 SVG 文件验证过。如果 Desktop 不发 `prompt.edit`，状态行上的提示就不会出现，但摘要不受影响。
