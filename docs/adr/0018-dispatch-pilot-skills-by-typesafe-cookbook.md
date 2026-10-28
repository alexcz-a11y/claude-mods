# Dispatch Pilot：skill 推荐照 TypeSafe 的 skill 推荐 cookbook 重写，门槛按各家的官方指南

0.8.x 的 skill 推荐是自己设计的（#10、#11）：一个便宜的模型给每个 skill 写中英文画像，第一段的选择题里有一个「都不合适」选项，第一段分到 0.1 以上的才进第二段，第二段相关度不低于 0.75 的最多推荐 3 个；`find_skill` 不低于 0.5 的最多返回 5 个。0.75 和 0.5 是在我们自己的评测集上挑的。用户 2026-10-28 决定：照 TypeSafe 官方的 skill 推荐 cookbook 改，问法和门槛以原文为准，门槛按决策模型分开（Jev、pplx 用 cookbook 的，d1-ultra 用 Liquid 的）；不跑评测；派出的 agent 照旧保留完整的 skill 列表（ADR 0002 的这一条不变）；白名单照旧按 skill 名写。

cookbook 的依据（docs.typesafe.ai/cookbooks/skill_suggestion，2026-10-28 读的全文）：

- 做法：「two TypeSafe requests per turn, one to rank skills and one to verify the choice」；「The first ranks every skill in the roster against the user's turn and answers whether the turn needs a skill at all. The second re-reads only the top three, now with each skill's full description and the opening of its instructions, and is free to reject all of them.」
- 常数：`SHORTLIST = 3`，`EXCERPT_CHARS = 700`，`GATE_THRESHOLD = 0.30`（「mean of the three request nouls, below which nothing is suggested」），`FITS_THRESHOLD = 0.30`（「a shortlist whose best "does this fit" noul is under this is dropped」）。
- 第一段：`CHOICE_INSTRUCTIONS = "Which of these skills, if any, is the right one to load to help with the user's latest request?"`，选项是全部 skill，每个用「the index description as each option's criteria (the same text the agent itself gets)」；三道门控题 `acts_on_user_system`、`would_follow_documented_procedure`、`prose_suffices`（「`prose_suffices` counts the other way round. Their mean decides whether to suggest anything at all」），「Write these three to ask whether an action is wanted」。
- 第二段：`RERANK_INSTRUCTIONS = "Exactly one of these skills is the right one to load for the user's latest request. Which one? Read what each actually does, not just its name."`，每个选项是 `f"{description_full} — {body[:excerpt]}"`；每个候选一道 `f"Does the skill '{name}' do the specific thing the user's request asks for? It is described as: {description_full}"`。「The Choice settles *which* skill, and the nouls settle *whether* to say anything at all.」
- `suggest()`：门控平均低于 0.30 返回空；第二段 fits 最高的低于 0.30 返回空；否则返回第二段选择题选中的那一个。
- `suggestion_block`：`Relevant to the current request: {names}. Ignore this if it does not fit what the user actually asked for.`，没有时 `No skill in the roster appears relevant to this request.`；「a turn with nothing to suggest still sends a sentence saying so; sending nothing at all would leave the roster's own "err on the side of loading" instruction unopposed」。
- 结果（488 个请求，claude-haiku-4-5）：装错 skill 从 16.8% 降到 7.3%，不该装时装了从 9.8% 降到 4.0%。

Liquid 的依据（docs.liquid.ai/guides/decision-model-guide，2026-10-28 重读）：二元判断 `if p > 0.8: ... elif p < 0.2: action = "allow"`；重排示例 `[c for c in scored_chunks if c["score"] > 0.5]`，「You can threshold directly (keep everything above 0.5)」。

决定：

- **第一段**（`decision/skills.ts` 的 `skillsPart`，和 effort 请求并行，ADR 0005）：`skills.which` 是主 agent 能加载的 skill 的选择题，问题是 cookbook 的原话，每个选项用 skill 自己的描述（引擎列表里的那段），没有「都不合适」；`skills.hint` 是只能由你触发的 skill 的同一题（cookbook 没有，#11 起为了两类不抢概率分开问，保留）；三道门控题 `skills.gate.<key>` 是 cookbook 的原话。某一类只有一个 skill 时不问它的选择题，它直接进第二段。
- **门控**：三道的平均（`prose_suffices` 反过来算，`readGate`）低于门槛就不推荐，也不发第二段。
- **第二段**（`stageTwoPart`）：每题前三名（cookbook 不设下限，所以 0.8.x 的 0.1 去掉了），一道选择题选哪个（选项是「描述 — SKILL.md 正文前 700 个字符」），每个候选一道 fits（cookbook 原话）。推荐第二段选择题选中的那一个，只在这一类里 fits 最高的过了门槛时才推荐；能加载的最多一个给主 agent，只能由你触发的最多一个给看板（「可试 /x」）。
- **给主 agent 的话**：cookbook 的 `suggestion_block` 原话；没有推荐时也附那一句。请求失败时什么也不附（不知道结果，不能说没有相关的）。
- **`find_skill`**：同一个排序入口，不问门控（主 agent 已经在要 skill），短名单是 `findSkillMax`；返回 fits 过了门槛的全部，从高到低（一样高时选择题给得多的在前），最多 `findSkillMax` 个。只有一个候选时不发第一段。
- **门槛不是选项**，写在 `decision/guides.ts` 的 `SkillBars`，按决策模型：Jev、pplx 是 cookbook 的（门控平均低于 0.30 不推荐，fits 最高的 ≥ 0.30 才推荐、≥ 0.30 才返回）；d1-ultra 是 Liquid 的（平均低于 0.2 不推荐，fits 要高于 0.5）。

照搬时改了的地方（cookbook 的 agent 和场景和这里不一样）：

- cookbook 的 agent 保留完整的 skill 列表，只是多看一行提示；这里主 agent 的列表被拿走（ADR 0002），所以第一次提到某个 skill 时，在 cookbook 那句话后面另起一行写它的描述，这段对话里再提到时只写那句话。
- cookbook 的 state 是 `{ "request": ..., "recent_context": "" }`（单轮请求）；这里是 mod 一直用的 `{ user_message, recent_context }`（多轮对话），问题的原话不变。
- cookbook 的目录有 182 个 skill，一题装得下，「A few times larger and you would split it into chunks」；这里没有分块，选择题超过 `questionBudget` 时把每个描述截到同样的 token 数，取放得下的最大值。
- 正文开头：cookbook 的 `body[:700]`；这里先去掉 frontmatter、折叠空白、脱敏，再取 700 个字符（0.8.x 是 180 个 token）。
- 只能由你触发的 skill 的那一题和看板提示，cookbook 没有，保留下来，挑法和能加载的一样。

删掉的：

- skill 画像：`core/profiles.ts`、`core/profile-report.ts`、`features/skill-profiles.ts`，`skill-profiles` 开关，`$.state` 的 `skillProfiles`，依据面板顶部的画像一行，`report` 的 `profiles` 一种，命令轮读画像的地方改读描述。
- 选项：`skillsMax`（固定一个）、`skillsShortlist`（固定三个）、`skillsMinRelevance`、`findSkillMinRelevance`（改由指南定）、`skillsProfileModel`、`skillsProfilesPerSession`；`PER_BACKEND_OPTIONS` 剩 `timeoutMs`、`contextMessages`、`contextTokens`，`BACKEND_DEFAULTS` 的 `findSkillProfiles` 去掉。
- skill 问题的中文问法（cookbook 只有英文原话；ADR 0014 起所有问题都用英文）。
- 评测：`eval/profiles.ts`、`datasets/skill-profiles.json`、skill suite 的 `profiles`、`descriptions`、`profiles-zh` 三个变体和门槛离线重扫；suite 只剩 `cookbook` 一个变体，和 mod 发的请求逐字相同。

不变的：主 agent 的列表照旧被换成那句固定的提示，`skillsAlwaysListed` 里的照旧留着（按 skill 名写；LSP plugin 不带 skill，不用写）；派出的 agent 照旧拿到完整列表，`find_skill` 照旧只为主 agent 工作；两段共用一次等待和第二段的保底（Jev 800 毫秒，d1-ultra 1500）；命令轮不推荐。

验证（2026-10-28）：

- 测试：`scripts/check.sh dispatch-pilot` 全部通过；skill 相关的测试按新做法重写（门控拦下、第二段推荐一个、fits 不够不推荐、没有推荐时的那句话、`find_skill` 返回多个、两套门槛、白名单 skill 保留、派出 agent 的列表不动）。
- 列表确实没进主 agent 的上下文：`claude -p --model haiku`，只用 `--plugin-dir` 加载工作区的 dp（用 `--settings` 把已安装的 `dispatch-pilot@alex-mods` 关掉，debug log 里只有 `dispatch-pilot@inline`），让模型逐条列出它在列表里看到的 skill：回答 `NONE`，debug log 有 `withheld the skill listing from the main agent (126 skills, 29840 characters); kept none; the note names find_skill`。同样的问题关掉 dp 再问：列出 126 个，和 dp 读到的「126 the main agent can load」一致。
- 那次运行里真实的 Jev 跑了一条消息的两段 skill 请求：第一段 5 题、11,610 个输入 token、1171 毫秒，门控平均 0.50，过了 0.30；第二段 8 题、2,385 个 token、298 毫秒，fits 最高 0.20，不推荐，主 agent 收到那一句「No skill in the roster appears relevant to this request.」。
- d1-ultra 只发了一次第一段（合成的 state，6 个 skill）：5 题、373 个输入 token、915 毫秒，选择题和门控都按 mod 的代码读出（门控平均 0.89，`anthropic-skills:pdf` 0.999）。
- 没有跑评测（用户的决定）；cookbook 和 Liquid 的门槛都没有在我们的评测集上量过。

版本号保持 0.9.0（和 ADR 0013 到 0017 是同一个版本）。
