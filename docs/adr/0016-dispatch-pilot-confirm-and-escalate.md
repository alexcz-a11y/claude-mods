# Dispatch Pilot：发消息时加两道是非题，「确认」沿用上一轮的 effort，「要求升级」至少 xhigh

ADR 0014 之后，主 agent 发消息时的判断有两处空白，是从 Liquid cookbook 的 telco-triage 示例看出来的：那个示例先判断「这句话和上文是什么关系」，其中两类 dp 没有。

- **确认 / 同意。** 你只说「好，就这么做」「继续」「选 2」。真正要做的是助手上一条提出的那件事，消息本身很短，effort 题按这几个字评，容易判低：助手刚提出一个大重构，你回「可以，开始吧」，这一轮可能按 low 去做。`solved` 的「是」里有「接受结果」，同意一个方案也可能被读成问题已经解决，把未解决次数清零。
- **要求升级。** 你说「这个你认真想想再改」「仔细一点」「用最强的来做」，没写 `ultrathink`，也没点名档位。主 agent 只认 `ultrathink` 和 `/dp lock`，这类话听不懂。

用户 2026-10-28 批准按建议加上，所有决策模型都问。

决定：

- **两道是非题**（`decision/asks.ts`），英文，和其余题在发消息时的同一个请求里，只问你自己的话（agent 交回的报告开始的一轮不问，和未解决那三道、长期约束一样）：
  - `confirm`：「Does `user_message` only agree to, continue, or pick from what the assistant offered at the end of `recent_context`, asking for nothing new?」是：只是让助手照它提出或问到的去做，没有新要求（"ok, do it"、"continue"、"选 2"）；否：提了新要求、报告了问题或结果、改了要做的事，或者上文末尾没有可以同意的东西。
  - `escalate`：「Does `user_message` ask the assistant to think harder, work more carefully, or use a stronger model?」是：要求多想、更仔细，或者更强的模型（"think it through carefully"、「仔细一点」「用最强的模型」）；否：只提要做的事，或者要求简单快速。
- **规则**（`decision/message-effort.ts`，和 R1–R5 一起取最高，只抬不压，锁定照旧压过一切）：
  - `escalate` 为是：这一轮至少 xhigh，等同 R1 的 `ultrathink`。
  - `confirm` 为是：这一轮至少等于你上一条消息那一轮的 effort（`lastTurn` 里记的、各步实际发出的档位）；没有记录就不起作用。
  - 拿不准或为否：都不起作用。是非题的线按决策模型的指南：Jev 和 pplx ≥ 0.7 / ≤ 0.3，d1-ultra > 0.8 / < 0.2（ADR 0017）。
- **不清零。** `confirm` 不碰未解决次数。`solved` 的「否」改成点名这种情形：「只是同意某个方案、让助手照做或继续，这不算问题已经解决」（TypeSafe 的 name the case that causes confusion）。清零的规则不变：`solved` 为是，或者 `new_task` 为是且 `still_failing` 为否；代码不拿 `confirm` 去改 `solved` 的答案（那是 TypeSafe 说的 code that quietly overrides answers）。
- **看得见。** 两条下限各是 trace 里的一步（`escalate`、`confirm`，在 `ultrathink` 之后、`stakes` 之前），写概率、是否、用的线；`confirm` 还写上一轮的档位。卡片写「要求多想」「确认」，band 的理由在它们抬了档时写它们。

考虑过的其他做法：

- **一道选择题判「和上文的关系」**（telco-triage 的写法：确认、修复失败、换话题、要求升级……）：几种关系可以同时成立（「还是不行，这次仔细点」既是修复失败又是要求升级），TypeSafe 要一条陈述一道是非题。
- **`confirm` 为是时代码不清零**（即使 `solved` 为是）：那是代码悄悄改答案；「好了，可以了，继续下一个」既是确认也是解决，不该不清零。改 `solved` 的 criteria 更直接。
- **`escalate` 拿不准时至少 high**（像出错代价那样）：要求多想是你明说的话，拿不准多半是没说，抬了反而多花。

代价：

- 发消息时的请求多两道题（约 200 估算 token），Jev 和 d1-ultra 都按 state 计一次，几乎不加钱和时间。
- 「好，提交吧」这类同意一个小动作的消息，也会沿用上一轮的高档位，多花一点。
- 没有评测（用户 2026-10-28 取消了第 3 阶段的验收），两道题的准确率不知道；冒烟时 Jev 和 d1-ultra 对「还是不行……你再仔细查查」都答 `escalate` 是（0.95、0.948）、`confirm` 否（0.05、0.062）。

版本号保持 0.9.0。
