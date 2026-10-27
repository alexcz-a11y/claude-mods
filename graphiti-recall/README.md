# graphiti-recall

替模型查 Graphiti 记忆，把相关的直接放进上下文；不相关就什么都不加。

## 什么时候查
- **每轮开头**：按你这条消息查。“ok / 继续 / 好”这类确认、斜杠命令不查。8 秒内没回来就先开始这一轮，结果附到下一个工具结果后。
- **运行中**：本会话第一次读或改某个文件、高风险命令（ssh、docker、部署、git commit/push、gh 建票合并、rm -rf）、工具报错（按“跑了什么 + 说明错在哪的那一行”查：Bash 用命令本身，读写文件用路径，MCP 用服务器和工具名；`Exit code 1` 这类行跳过）。每轮最多 3 次，每一步最多 1 次。
- **派子代理**：用任务描述查，结果附在子代理任务末尾。
- 同一话题第二次查时，带上一次第一条结果的 `source_node_uuid` 作中心节点，改按图距离往外看。

## 先改写成关键词
服务端给“整句查询有多有用”打分（graphiti-mcp `-p26` 起用 Cohere rerank-v5.0-pro，事实和实体都要 ≥ 0.50），原话里“你先回忆一下”“能看到……吗”这类话会把分数拉到线下。所以除了文件路径（本身就是关键词），消息、子代理任务、高风险命令和报错都先交给 Haiku（`effort: low`，实测 1.7–3.3 秒）改写成一行关键词；问了两个不相干话题时改成两行，分别查再合并。

- 只送这一条消息或这一次工具调用的文本，去掉 `<system-reminder>` 之类包装，密钥打码；不送对话。
- 走你的 Claude Code 登录，用你套餐的用量。模型由选项 `rewriteModel` 决定（默认 `haiku`，留空则不改写）。
- 4 秒内没改写成、或回复读不出关键词时，用原来的规则从原文取查询（代码块和粘贴内容只取路径、票号、标识符），灰字里标出“原文（改写未成：…）”。
- Haiku 判定没有可检索的主题（回复“无”）时不查。

同一条记忆一个会话只注入一次，模型自己用 `search_*` 查到过的也不再注入。

## 在对话里看到什么
每次召回留一行灰字（模型读不到）：

```
记忆召回 #r3 · 轮首 · 查询「dispatch-pilot summaryModel 模型 | image-pane herdr 空白 blank」 · 已注入 1 条事实、3 个实体
记忆召回 · 工具后 · Read OPS-NOTES.md · 查询「ops/OPS-NOTES.md OPS-NOTES ops」 · 无相关记忆，未注入
记忆召回 · 工具后 · Bash 报错 · 查询「ssh Gragh docker restart graphiti-mcp · ssh: connect to host gragh port 22: Connection refused」 · 无相关记忆，未注入
```

“已注入”只在看到这段内容真的随请求发给模型后才写；被别的插件拦下、没存进对话，都会照实写出来。

`/recall` 看状态，`/recall off` / `/recall on` 开关，`/recall last` 看最近几次注入了什么。状态行显示本会话的次数和条数。

## 分区
和 `~/.claude/CLAUDE.md` 同一套规则：`.graphiti-group-id` 文件 → `repo_<slug>` → `life`。仓库没有 origin、也没有那个文件时不猜，直接停用。

## 出错时
一次检索报错或超过 8 秒，暂停 5 分钟；连续 3 次失败，本会话停用。

## 要求
- Claude Code 2.1.304 及以上（Desktop 用它自带的 Claude Code）。
- 用户级 MCP 服务器 `graphiti`，且服务端有 `recall` 工具（graphiti-mcp `-p24` 起；分数线 0.50 配合关键词查询需 `-p26`）。

## 安装
```
claude plugin install graphiti-recall@alex-mods
```
