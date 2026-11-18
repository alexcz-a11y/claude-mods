# dispatch-pilot 开发说明

## 代码放在哪里（Where code lives）

- **纯模块** `hooks/*.ts`（agents、backend、decide、journal、log、midrun、progress、questions、readout、skills、statebuild、submit、state、levels、config）和 `hooks/board/model.ts`（看板的数据）：判断、计划、文字和类型，不碰 `$`。
- **flow** `hooks/flows/*.ts`：每个功能一个文件，放在它的纯模块旁边（dp、submit、skills、agents、midrun、progress、readout）。读写状态、发请求、调 `$` 的代码都在这里，导出以 `$` 为第一个参数的顶层函数。模块级变量跟着它的 flow 走，入口要赋值或读它时，由 flow 导出一个只做这一件事的小函数。
- **`hooks/runtime.ts`**：各 flow 共用的部分，即 `trace`、`failOpen`、`ioOf`、`record` 和它的 `$.store` 写入链、`amendSent`、`verifies`、`keepSurfaces` 和共用常量。除了 flow，只有它碰 `$`。
- **入口** `hooks/dispatch-pilot.ts`：只有 `register` 和每个 `on(...)`，每个 hook 里是各功能动手的先后顺序。它不直接调 `$.`，也不读写状态。
- flow 只在真的调用时才导入别的 flow（midrun → progress，submit → skills），不能成环。

两条引擎规则决定了这个布局（2.1.327 实测）：

- **atom 要在用它的文件里声明。** `read`/`update` 的状态来源必须是字面量引用，或者是本文件里一个 const 的 `atom`/`memberOf`/`derive`。从别的文件导入的 atom 会让模块加载失败，validate 和测试工具都报 `the state library's read takes a source the scan can read: … written there or in a const of this file`。所以每个文件在顶部各自声明自己用到的 atom，一个一行，默认值取自 `hooks/state.ts` 或同样的字面量。`eval/validate.ts` 会检查同一个 key 的声明逐字相同。agents 这一族照旧在每个调用处写出字面量引用。
- **`$` 可以交给导入的顶层函数。** validate 和测试工具都顺着导入扫描，validate 列出调用时写成 `$.command.register (via registerDp)` 这样。限制只是：不起别名、不解构、不交给局部函数。

## skill 推荐和 TypeSafe cookbook 不同的地方

推荐照 TypeSafe 的 skill_suggestion cookbook 做（设计 3.4、5.6 节，ADR 0018、0021），题目原话一字不改，只有一处不同：cookbook 第二次请求的选项是「说明加 SKILL.md 正文前 700 个字符」；mod 拿不到 skill 文件的路径（`CommandInfo` 没有路径），所以第二次请求的选项只用 skill 列表里的说明。

另外两点：候选按来源排序后分成 ceil(n/250) 批、每批数量尽量相等（不是 250 加余数），这样不会出现只有一个选项的批：Jev 的选择题要 2 到 255 个选项，被拒的一题会让整个请求失败，同一请求里的 effort 判断也跟着失败。只有一个候选（或短名单只有一个）时，Jev 不问这道选择题，直接看 fits；Drex 的选项多一个 `other`，照常问。

## 实际发出的档位：测试里发不出引擎的请求

`http.fetch` 的读数（设计 5.12）只认 `next.origin.plugin` 为 `engine` 的请求，而 2.1.327 的测试工具发不出这样的请求：测试拿到的 `$` 没有 `http`（只有 tool、command、config、telemetry、prompt、skill、attribution、agent、session、turn、ui、classic）；内联插件用自己的 `$.http.fetch` 发的请求，到每个 hook 时 `next.origin.plugin` 都是那个插件的名字；名叫 `engine` 的内联插件加载不了（"the name is the engine's own chain member"）。

所以 `tests/readout.test.ts` 分两段测引擎请求的读数：先用引擎事件把会话跑到某一步，从 world 记下的写入里取出状态（哪条决策在等核对、记录里有什么），交给一个替身 `$`；再直接调 `hooks/flows/readout.ts` 导出的 `openStep` 和 `readout`，读一次引擎的请求，看替身里写了什么。hook 本身用内联插件 `wire` 发请求来测：请求原样到达底层；prepend 层的 `fetch-watcher` 读 `next.trace`，看 mod 的 hook 在不在链上（`verifyEffort` 关着时不在）、每一环收到的是不是同一个请求。
