# skill 套（#16）审核总结

审核人：claude-opus-5-5/high，2026-10-04。决定记录在 `review/skill.review.jsonl`，共 109 行，每题一行。

## 结果

| 决定 | 题数 |
|---|---|
| 同意 | 105 |
| 改答案 | 4（skill-017、042、084、100） |
| 备注 | 0 |

`apply-review.ts --dry-run` 校验通过：0 个错误，0 道未审，没有比例警告。

## 规则决定

**1. 插件的 markdown 命令算不算候选（skill-009）：算。**
spec 规定候选是「所有可被模型调用的 skill」，判断标准是引擎是否把它列给主 agent。`claude-md-management:revise-claude-md` 出现在 skill_listing 和 `skillFrontmatter` 里，Skill 工具可以加载，mod 也会从同一处拿到它。所以它和普通 skill 一视同仁，kind 不同不影响。skill-009 同意。

**2. 两个 skill 并列 gold（skill-084、109、052，并影响 100）：允许。**
gold 的含义是「理想推荐器应该推的那组 skill，按优先级排序」，推荐上限是 3 个。以下两种情况允许 gold 有多个：一是两个 skill 都直接覆盖整个任务，分不出谁更好（084、109 的 skill-creator 和 writing-for-agents；052 的 claude-api 和 typesafe-ai）；二是任务分成几部分，每部分各由一个 skill 直接覆盖（019、090、099、105）。其他情况一律只留一个 gold，次优的放进 accept。如果强行二选一，选哪个都是任意的，推荐器只是因为排序稍有不同就会被判错。按这条规则，skill-100 改成 run 和 ego-browser 并列 gold，run 排第一。

**3. claude-api 的触发词字面命中但其实无关（skill-041、024）：看 skill 内容是否覆盖任务，不看触发词是否命中。**
claude-api 的描述是为了让它自己尽量被触发而写的，范围极宽。判断时看它的正文能不能帮上这个任务。具体分三种：内容完全不覆盖、而这道题本来就是考这个陷阱的，标为干扰项（041：问的是 Claude Code 里切换会话模型的命令，不是 API）；路线说得通但不是最好的，放中立（024：800 条反馈要逐条给概率，jev-batch 几乎逐字对应，用 Claude API 分类也说得通，但给不出现成的概率）；真的要选模型、写 LLM 调用的，列为 gold（052、053）。两题都同意。

**4. 干扰项定得是否过严（skill-042、017、100、084）：只把会把主 agent 带偏的 skill 列为干扰项。**
满足以下任一条件才列为干扰项：skill 的描述自己写了不适用于这种情况；加载后主 agent 会做错事或产生不需要的副作用，例如写出一份调研笔记、重试一个已知会 401 的调用；只是字面或名字相近，内容并不覆盖任务。如果 skill 的内容说得通、只是不必要或不是首选，就放中立，也就是既不在 accept 也不在 must_not。干扰项不要求列全，与题目无关的 skill 默认都是中立。据此改了 3 题：017 的 run（用户要的正是启动 dev server）、042 的 openai-image（广告图需要一张位图，用它出底图是说得通的路线）、084 的 pr（要写的 skill 讲的就是本团队开 PR 的规范，pr 是素材）。这三个都从干扰项改为中立。skill-100 的 tdd 和 computer-use 保留为干扰项。

**5. 抓网页用浏览器 skill 还是 WebFetch 就够（skill-079）：推荐浏览器 skill。**
推荐器只负责把 skill 推给主 agent，用不用由主 agent 决定，推荐了也不会强制它用浏览器。「去某个站抓今天的榜单」的意思就是「打开网站、提取页面数据」，ego-browser 的描述明确要求遇到这种情况默认读它。Product Hunt 这类重 JS 的站，WebFetch 也经常抓不全。所以不改成「无 skill」。built-in-browser 依赖桌面 app，但题目没有限定用的是哪种界面，留在 accept 可以接受。

**附：中立的 skill 怎么计分。**
024 的 claude-api、052 的 ElevenLabs agents 这类中立 skill，按校验脚本的语义，只推它一个时算未命中，因为它不在 accept 里；和 gold 一起推不扣分，也不算踩干扰项。两题都同意这样放。

## 改了哪些题

| id | 改动 | 理由 |
|---|---|---|
| skill-017 | must_not `["herdr","run"]` → `["herdr"]` | run 的描述就写了「run, start … the app」，加载它不会把主 agent 带偏，改为中立（规则 4） |
| skill-042 | must_not `["openai-image","ui-ux-pro-max:slides"]` → `["ui-ux-pro-max:slides"]` | 用 gpt-image 出广告底图说得通，只是不是首选，改为中立（规则 4） |
| skill-084 | must_not `["pr"]` → `[]` | pr 记的 PR 写法正是要写的 skill 的素材，改为中立；两个并列 gold 保留（规则 2、4） |
| skill-100 | gold `["run"]` → `["run","ego-browser"]` | 「起前端」和「在浏览器里点一遍、截图」各由一个 skill 直接覆盖，并列 gold（规则 2） |

## 需要跟进

- 上面 4 题的 rationale 是按旧答案写的，要改写：017 和 042 删掉把 run、openai-image 当干扰项的说法；084 删掉 pr 是干扰项的说法；100 改成两者并列。
- 中英文对照：109 题逐题看过，两版含义一致，中文读起来像真实用户写的，没有需要改的。
- 评分实现（#16）：要明确中立 skill 的计分方式（见上面「附」），并在评测报告里另报 gold 精确命中率，避免 accept 放宽后把指标冲淡。
- skill-079 和 040 等题的 accept 里有依赖桌面 app 的 skill（例如 built-in-browser）。如果以后评测要模拟终端会话，把它们移到中立。

## 比例

- 「完全不该推荐任何 skill」（gold 为空且没有 user_only_hint）：22 / 109 = 20.2%，刚过 20% 的下限。这次审核没有改动任何一道 gold 为空的题，所以数字和起草时一样。以后如果再有题从「无 skill」改成有答案，就会跌破下限。gold 为空的题一共 34 道，包括只提示 user-only skill 的那些。
- 提示 user-only skill 的题：17 道（下限 10）。
- hard 题：94 / 109 = 86%（下限 70%）。
- 并列 gold 的题：019、052、084、090、099、100、105、109，共 8 道。
