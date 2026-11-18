# dispatch-pilot 开发说明

## skill 推荐和 TypeSafe cookbook 不同的地方

推荐照 TypeSafe 的 skill_suggestion cookbook 做（设计 3.4、5.6 节，ADR 0018、0021），题目原话一字不改，只有一处不同：cookbook 第二次请求的选项是「说明加 SKILL.md 正文前 700 个字符」；mod 拿不到 skill 文件的路径（`CommandInfo` 没有路径），所以第二次请求的选项只用 skill 列表里的说明。

另外两点：候选按来源排序后分成 ceil(n/250) 批、每批数量尽量相等（不是 250 加余数），这样不会出现只有一个选项的批：Jev 的选择题要 2 到 255 个选项，被拒的一题会让整个请求失败，同一请求里的 effort 判断也跟着失败。只有一个候选（或短名单只有一个）时，Jev 不问这道选择题，直接看 fits；Drex 的选项多一个 `other`，照常问。

## 实际发出的档位：测试里发不出引擎的请求

`http.fetch` 的读数（设计 5.12）只认 `next.origin.plugin` 为 `engine` 的请求，而 2.1.327 的测试工具发不出这样的请求：测试拿到的 `$` 没有 `http`（只有 tool、command、config、telemetry、prompt、skill、attribution、agent、session、turn、ui、classic）；内联插件用自己的 `$.http.fetch` 发的请求，到每个 hook 时 `next.origin.plugin` 都是那个插件的名字；名叫 `engine` 的内联插件加载不了（"the name is the engine's own chain member"）。

所以 `tests/readout.test.ts` 分两段测引擎请求的读数：先用引擎事件把会话跑到某一步，从 world 记下的写入里取出状态（哪条决策在等核对、记录里有什么），交给一个替身 `$`；再直接调入口导出的 `openStep` 和 `readout`，读一次引擎的请求，看替身里写了什么。hook 本身用内联插件 `wire` 发请求来测：请求原样到达底层；prepend 层的 `fetch-watcher` 读 `next.trace`，看 mod 的 hook 在不在链上（`verifyEffort` 关着时不在）、每一环收到的是不是同一个请求。
