# board-scenes

目测 dispatch-pilot 看板用的探针插件，不属于 mod。它回答 dispatch-pilot 对自己四个状态键（`session`、`turn`、`recent`、`skills`）的读取，换成六个固定场景之一。真的时间轴、面板和脚部标签照常画，不跑任何一轮，也不发模型或决策模型的请求。

- 放在 `docs/research/` 下，`claude --plugin-dir .` 不会把它和仓库里的 mod 一起加载。
- `hooks/scenes-data.ts` 是 `dispatch-pilot/tests/support/scenes.ts` 的原样拷贝，看板的测试断言的就是这六个场景。两个文件不一样时 `dispatch-pilot/eval/validate.ts`（也就是 `scripts/check.sh`）会失败。改了场景就在仓库根目录重新拷一次：

  ```bash
  cp dispatch-pilot/tests/support/scenes.ts docs/research/board-scenes/hooks/scenes-data.ts
  ```

- 读取先照常落到真的状态里，保留它的版本号，只把值换成场景的。这样 mod 自己的写入照样成功，读到的却一直是场景。如果固定回答版本 1，mod 的每次 `update()` 都会对不上版本，重试到上限后放弃。

## 六个场景（`/dpscene <名字>`，或启动时设 `DP_SCENE=<名字>`，默认 `up`）

| 场景 | 显示什么 |
|---|---|
| `up` | Code Mode 会话，第 7 轮第 10 步。第 6 步后由 medium 升到 high，已发出；上次评估「不变」，带四道条件题的值；下次评估「下一份脚本结果到达时」；面板里有两个 agent |
| `start` | 刚发消息，第 1 步。发消息时由 medium 升到 high；面板最后一区是推荐的 skill（`superpowers:systematic-debugging`） |
| `ordinary` | 普通会话，第 3 轮第 14 步。第 13 步后评估失败（Drex 超时），档位不变；下次评估「再 8 步」；功能那一行末尾写后端出了问题 |
| `notsent` | 第 7 步后决定升到 xhigh，还没发出：状态写「要 xhigh，实际发出 high」，换挡后面标「（还没发出）」 |
| `idle` | 两轮之间：时间轴只有一行（会话设定的 medium、上一轮结束在 high、下次评估和它的说明） |
| `locked` | `/dp lock high` 锁定后的一轮：状态「已锁定」，下次评估「不评估」，三项换挡标「锁定」 |

`/dpscene` 不带名字，或者名字不认识时，会列出这六个名字和现在的场景。

## 怎么看（终端）

在仓库根目录执行。命令里的 `command claude` 绕过带参数的 alias。

`--plugin-dir` 加载的 mod 拿不到 userConfig 里的选项，没有密钥时每个场景都会显示「未生效 … ! 没有密钥」和「本轮不再评估」，和下表说的不一样。所以启动命令用 `--settings` 给 dispatch-pilot 一个 Drex 密钥。这个值是编的，不能通过任何认证；探针会话里不发任何消息，所以它也从来不会被发出去。

1. 在 tmux 里开一个 180 列的会话。宽度够时面板停靠在右边；面板开着时，时间轴只留到轨道那一行为止：

   ```bash
   tmux new-session -d -s dps -x 180 -y 50 "command claude --plugin-dir ./dispatch-pilot --plugin-dir ./docs/research/board-scenes --settings '{\"pluginConfigs\":{\"dispatch-pilot@inline\":{\"options\":{\"drexApiKey\":\"scene-only-not-a-key\"}}}}'"
   sleep 14
   tmux attach -t dps
   ```

2. 在会话里输入 `/dpscene notsent`（或别的场景名），再输入 `/dp` 打开或关上面板。换场景时，时间轴、面板和脚部标签会一起重画：探针给这三处各挂了一个原样放行的渲染 hook，`$.ui.invalidate` 只会重画本插件的 matcher 选得中的实例（在测试工具里实测过，真机上还没看过）。如果面板开着却还停在上一个场景，输两次 `/dp` 让它重画。
   没有后端时的样子也值得看一次：启动命令去掉 `--settings …` 那一段，每个场景就都是「未生效 … ! 没有密钥」。
3. 看 100 列的样子：先按 `ctrl-b d` 离开，再执行下面的命令，等几秒后重新 attach。宽度不够停靠时，面板落到 prompt 上方：

   ```bash
   tmux resize-window -t dps -x 100
   sleep 5
   tmux attach -t dps
   ```

4. 一次截下六个场景。每个场景存成 `.txt` 和带颜色的 `.ansi` 两份，tmux 会把颜色量化。不写场景名时截全部六个：

   ```bash
   SCRATCH=$(mktemp -d)
   python3 docs/research/board-scenes/capture.py tmux dps "$SCRATCH" 180
   grep -l "要 xhigh，实际发出 high" "$SCRATCH/tmux-notsent-180.txt"
   grep -l "已锁定" "$SCRATCH/tmux-locked-180.txt"
   ```

   在 herdr 的 pane 里也可以这样截：`python3 docs/research/board-scenes/capture.py herdr <pane_id> <out_dir> <后缀> [场景 ...]`。

5. 看完关掉会话，确认没有残留：

   ```bash
   tmux kill-session -t dps
   pgrep -fl "board-scenes"
   ```

   `pgrep` 应该没有输出。用 `--plugin-dir` 加载会在 `docs/research/board-scenes/` 下生成 `.claude-plugin/types/`（它自带一个 `.gitignore`）。如果还生成了 `tsconfig.json`，删掉它，不要提交。

## Desktop

Desktop 上，轨道、五格和概率条各画成一张 Svg，还会写状态行（例如「high · ↑ 第 6 步后由 medium 升到 high」）。但 Claude Desktop 自带的 Claude Code 是 2.1.325，低于 mod 要求的 2.1.327，所以现在还不能在 Desktop 上目测。Desktop 的画法目前只由 `dispatch-pilot/tests/board-desktop.test.tsx` 验证。

看到的如果是引擎的行为（版本、宽度、行为），写进 dispatch-pilot 的 DEVELOPMENT.md。
