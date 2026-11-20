# Dispatch Pilot：一轮中途也可以升到 max，升到 max 和升到 xhigh 共用一个门槛

2026-11-20 用户的决定（「修改代码允许中途换挡可以切换到max门槛和xhigh共用一个」）。ADR 0030 定的是一轮中途最高到 `xhigh`，`max` 只能从发消息定档、agent 定档、沿用上一轮或手动锁定得到。

## 决定

- `midrunLevel`（`hooks/decide.ts`）的上限从 `xhigh` 改成 `max`。`decide` 逐档往上读：从 `xhigh` 升到 `max` 要「该用 max」的概率到 `midrunUpHigh`，和升到 `xhigh` 用的是同一个值（默认 0.80）；不新增选项。
- 同一失败又出现、结果和计划矛盾这两道题读成「是」时仍是至少升一档，从 `xhigh` 也升到 `max`；已在 `max` 时不变。降档的规则不变。
- 看板的「下次怎样会换档」在 `xhigh` 上也列出升到 `max` 的那一行，在 `max` 上写「已是最高档 max，不会再升」。
- eval：`direct` 读法的中途升档不再截到 `xhigh`；中途 `up` 用例的 `accept` 可以含 `max`。

## 后果

- 校准（eval/CALIBRATION.md）是在上限为 `xhigh` 时做的，没有中途该升到 `max` 的用例，0.80 用在 `max` 上没有依据，沿用初值。midrun 用例里写着「xhigh 是一轮中途能到的最高档」的理由文字是当时的说法，没有改。
- 中途升到 `max` 只由测试验证，没有在真实会话里跑过。
- 版本 1.0.3。
