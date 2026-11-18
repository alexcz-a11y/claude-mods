# dispatch-pilot 开发说明

## skill 推荐和 TypeSafe cookbook 不同的地方

推荐照 TypeSafe 的 skill_suggestion cookbook 做（设计 3.4、5.6 节，ADR 0018、0021），题目原话一字不改，只有一处不同：cookbook 第二次请求的选项是「说明加 SKILL.md 正文前 700 个字符」；mod 拿不到 skill 文件的路径（`CommandInfo` 没有路径），所以第二次请求的选项只用 skill 列表里的说明。
