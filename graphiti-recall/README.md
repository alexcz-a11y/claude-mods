# graphiti-recall

替模型查 Graphiti 记忆，把相关的直接放进上下文；不相关就什么都不加。

## 什么时候查
- **每轮开头**：用你的原话查（代码块和粘贴内容只取路径、票号、标识符）。“ok / 继续 / 好”这类确认、斜杠命令不查。6 秒内没回来就先开始这一轮，结果附到下一个工具结果后。
- **运行中**：本会话第一次读或改某个文件、高风险命令（ssh、docker、部署、git commit/push、gh 建票合并、rm -rf）、工具报错。每轮最多 3 次，每一步最多 1 次。
- **派子代理**：用任务描述查，结果附在子代理任务末尾。
- 同一话题第二次查时，带上一次第一条结果的 `source_node_uuid` 作中心节点，改按图距离往外看。

检索和相关度判断都在服务端的 `recall` 工具里（graphiti-mcp overlay 0026）：事实 ≥ 0.6、实体 ≥ 0.9 才返回。同一条记忆一个会话只注入一次，模型自己用 `search_*` 查到过的也不再注入。

## 在对话里看到什么
每次召回留一行灰字（模型读不到）：

```
记忆召回 #r3 · 轮首 · 查询「graphiti 检索分数线 中心节点」 · 已注入 5 条事实、1 个实体
记忆召回 · 工具后 · Read OPS-NOTES.md · 查询「ops/OPS-NOTES.md OPS-NOTES ops」 · 无相关记忆，未注入
```

“已注入”只在看到这段内容真的随请求发给模型后才写；被别的插件拦下、没存进对话，都会照实写出来。

`/recall` 看状态，`/recall off` / `/recall on` 开关，`/recall last` 看最近几次注入了什么。状态行显示本会话的次数和条数。

## 分区
和 `~/.claude/CLAUDE.md` 同一套规则：`.graphiti-group-id` 文件 → `repo_<slug>` → `life`。仓库没有 origin、也没有那个文件时不猜，直接停用。

## 出错时
一次检索报错或超过 8 秒，暂停 5 分钟；连续 3 次失败，本会话停用。

## 要求
- Claude Code 2.1.304 及以上（Desktop 用它自带的 Claude Code）。
- 用户级 MCP 服务器 `graphiti`，且服务端有 `recall` 工具（graphiti-mcp `-p24` 起）。

## 安装
```
claude plugin install graphiti-recall@alex-mods
```
