// PROTOTYPE, throwaway (2026-11-19). Question: dispatch-pilot's pane, two round boxes (picked from looks A-D): the
// basis of the last shift, kept until the next shift, and the forecast of the next evaluation. This round asks how to
// word them so a person reads them at once: 1 sentences, 2 questions and answers, 3 a small table. Numbers are
// written in by hand. /dpproto <1|2|3> <down|up|none> switches; bare /dpproto opens or closes the pane.
import type { Register } from 'claude-code'

type Tone = 'plain' | 'dim' | 'ok' | 'warn' | 'accent' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
const LOOK: Record<Tone, any> = {
  plain: {}, dim: { dimColor: true }, ok: { color: 'success' }, warn: { color: 'warning' }, accent: { color: 'claude' },
  low: { color: 'inactive' }, medium: { color: 'suggestion' }, high: { color: 'warning' }, xhigh: { color: 'claude' }, max: { color: 'error' },
}
type Level = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
/** One rung the open question was checked at: "该用 <level> 或更低/更高" got p, against the bar. */
type Rung = { level: Level; p: number; bar: number }
type Shift = {
  dir: 'up' | 'down'; from: Level; to: Level; at: string
  /** The yes/no answer that allowed (down) or forced (up) the move, in plain words. */
  flag: { name: string; plain: string; p: number; bar: number; does: string }
  /** The rungs checked, in order; the last one failed unless the move ran to the end. */
  rungs: Rung[]
  /** The open question alone did not move it (a flag forced the move). */
  byFlagOnly: boolean
  since: string
}
type Scene = {
  title: string; level: Level; where: string
  shift: Shift | null
  next: { when: string; left: number; basis: string; up: Rung | null; down: Rung | null }
  last: string
}

const SCENES: Record<string, Scene> = {
  down: {
    title: '降档之后连着两次不变（你截图那次）', level: 'medium', where: '第 9 轮 · 第 20 步 · Code Mode 会话',
    shift: {
      dir: 'down', from: 'xhigh', to: 'medium', at: '第 17 步后',
      flag: { name: '只剩照做', plain: '剩下的只是照已定的做法做完', p: 0.85, bar: 0.7, does: '允许降' },
      rungs: [{ level: 'high', p: 0.92, bar: 0.7 }, { level: 'medium', p: 0.89, bar: 0.7 }, { level: 'low', p: 0.6, bar: 0.7 }],
      byFlagOnly: false, since: '之后 2 次评估都没变（第 18、19 步后）',
    },
    next: { when: '下一份脚本结果到达时', left: 3, basis: '第 19 步后那次评估', up: { level: 'high', p: 0.1, bar: 0.7 }, down: { level: 'low', p: 0.55, bar: 0.7 } },
    last: '第 19 步后 · 不变 · Drex · 640 ms',
  },
  up: {
    title: '同一失败又出现，升了一档', level: 'high', where: '第 7 轮 · 第 10 步 · Code Mode 会话',
    shift: {
      dir: 'up', from: 'medium', to: 'high', at: '第 6 步后',
      flag: { name: '同一失败又出现', plain: '同一个失败修过之后又出现了', p: 0.91, bar: 0.7, does: '直接升一档' },
      rungs: [{ level: 'high', p: 0.4, bar: 0.7 }],
      byFlagOnly: true, since: '之后 3 次评估都没变（第 7、8、9 步后）',
    },
    next: { when: '下一份脚本结果到达时', left: 3, basis: '第 9 步后那次评估', up: { level: 'xhigh', p: 0.22, bar: 0.8 }, down: { level: 'medium', p: 0.48, bar: 0.7 } },
    last: '第 9 步后 · 不变 · Drex · 702 ms',
  },
  none: {
    title: '这一轮还没有换挡', level: 'medium', where: '第 3 轮 · 第 4 步 · Code Mode 会话',
    shift: null,
    next: { when: '下一份脚本结果到达时', left: 4, basis: '第 3 步后那次评估', up: { level: 'high', p: 0.31, bar: 0.7 }, down: { level: 'low', p: 0.27, bar: 0.7 } },
    last: '第 3 步后 · 不变 · Drex · 655 ms',
  },
}
const VARIANTS = ['1', '2', '3'] as const
const VARIANT_NAME: Record<string, string> = { '1': '句子', '2': '问答', '3': '小表格' }
const PANE = 'board-proto'
let variant = '1'
let scene = 'down'

const pct = (p: number) => Math.round(p * 100) + '%'
const LOWEST: Level = 'low'
const HIGHEST: Level = 'max'
/** "该用 high 或更低" / "该用 xhigh 或更高"; the end levels need no "或更…". */
const rungName = (r: Rung, dir: 'up' | 'down') => '该用 ' + r.level + (dir === 'down' ? (r.level === LOWEST ? '' : ' 或更低') : r.level === HIGHEST ? '' : ' 或更高')
const passes = (r: Rung) => r.p >= r.bar - 1e-9
const steps = (from: Level, to: Level) => { const L = ['low', 'medium', 'high', 'xhigh', 'max']; return Math.abs(L.indexOf(to) - L.indexOf(from)) }
// Columns for the table: CJK and full-width take two.
const width = (s: string) => [...s].reduce((n, c) => n + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(c) ? 2 : 1), 0)
const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - width(s)))

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    const env = (await $.env.get('DP_PROTO').catch(() => undefined)) ?? ''
    for (const w of env.split(/\s+/)) {
      if ((VARIANTS as readonly string[]).includes(w)) variant = w
      if (w in SCENES) scene = w
    }
    await $.command.register({ name: 'dpproto', description: 'PROTOTYPE: dispatch-pilot pane boxes, wordings 1-3', argumentHint: '1|2|3 down|up|none', immediate: true }).catch(() => undefined)
    return r
  })

  on('command.run', { command: 'dpproto' }, async ($, e) => {
    const words = e.args.trim().split(/\s+/).filter((w) => w !== '')
    const open = (await $.ui.panes()).some((p) => p.id === PANE)
    if (words.length === 0) {
      if (open) await $.ui.close({ id: PANE })
      else await $.ui.open({ id: PANE, title: 'PROTOTYPE · 看板分区' })
      return { text: open ? '原型面板已关' : '原型面板已开：/dpproto 1|2|3 down|up|none 切换', isTextDisplayOnly: true }
    }
    for (const w of words) {
      if ((VARIANTS as readonly string[]).includes(w)) variant = w
      else if (w in SCENES) scene = w
    }
    if (!open) await $.ui.open({ id: PANE, title: 'PROTOTYPE · 看板分区' })
    $.ui.invalidate('ui.render')
    return { text: '写法 ' + variant + '（' + VARIANT_NAME[variant] + '）· 场景 ' + scene + '（' + SCENES[scene]!.title + '）', isTextDisplayOnly: true }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.surface !== 'terminal' && e.surface !== 'desktop') return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const s = SCENES[scene]!
    const t = (tone: Tone, str: string, bold = false) => <Text {...LOOK[tone]} {...(bold ? { bold: true } : {})}>{str}</Text>
    const line = (...kids: any[]) => <Text wrap="wrap">{kids}</Text>
    const blank = <Text> </Text>
    const lvl = (l: Level) => t(l, l, true)
    const ok = (yes: boolean) => (yes ? t('ok', '✓') : t('dim', '✗'))
    const box = (title: string, kids: any[]) => (
      <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
        {t('accent', title, true)}
        {kids}
      </Box>
    )
    const head = (sh: Shift) => line(t(sh.dir === 'up' ? 'warn' : 'medium', sh.dir === 'up' ? '↑ ' : '↓ ', true), t('dim', sh.at + ' '), lvl(sh.from), ' → ', lvl(sh.to), t('dim', steps(sh.from, sh.to) > 1 ? '（' + (sh.dir === 'up' ? '升' : '降') + steps(sh.from, sh.to) + '档）' : ''), t('ok', '  ✓ 已生效'))
    const n = s.next

    let shiftKids: any[]
    let nextKids: any[]
    if (s.shift === null) shiftKids = [line(t('dim', '这一轮还没有换过档'))]

    if (variant === '1') {
      if (s.shift !== null) {
        const sh = s.shift
        if (sh.dir === 'down') {
          const stop = sh.rungs.at(-1)!
          shiftKids = [
            head(sh),
            line(t('plain', '能降，是因为'), t('dim', '：' + sh.flag.plain + '（模型 ' + pct(sh.flag.p) + ' 确定，过 ' + pct(sh.flag.bar) + ' 才算）')),
            line(t('plain', '降到 ' + sh.to + ' 为止，是因为'), t('dim', '模型估计这件事：')),
            ...sh.rungs.map((r) => line(t('dim', '  ' + rungName(r, 'down') + ' 的可能 '), t(passes(r) ? 'ok' : 'plain', pct(r.p), true), t('dim', passes(r) ? '，够 ' + pct(r.bar) : '，不够 ' + pct(r.bar) + '，停'))),
            line(t('dim', sh.since)),
          ]
          void stop
        } else {
          const r = sh.rungs[0]!
          shiftKids = [
            head(sh),
            line(t('plain', '升，是因为'), t('dim', '：' + sh.flag.plain + '（模型 ' + pct(sh.flag.p) + ' 确定）。遇到这种情况直接升一档。')),
            line(t('dim', '单看难度本来不够升：' + rungName(r, 'up') + ' 的可能 ' + pct(r.p) + '，要 ' + pct(r.bar) + '。')),
            line(t('dim', sh.since)),
          ]
        }
      }
      nextKids = [
        line(t('plain', n.when + '再评估'), t('dim', '（这一轮还能换 ' + n.left + ' 次）')),
        n.up === null ? line(t('dim', '已在最高档')) : line(t('warn', '↑ ', true), t('plain', '升到 ' + n.up.level), t('dim', '：要模型估计「' + rungName(n.up, 'up') + '」到 ' + pct(n.up.bar) + '，上次是 '), t('plain', pct(n.up.p), true)),
        n.down === null ? line(t('dim', '已在最低档')) : line(t('medium', '↓ ', true), t('plain', '降到 ' + n.down.level), t('dim', '：要「' + rungName(n.down, 'down') + '」到 ' + pct(n.down.bar) + '，上次是 '), t('plain', pct(n.down.p), true), t('dim', '；还要模型判断原因已查明，或者剩下的只是照做')),
        line(t('accent', '! ', true), t('dim', '同一个失败修了又出现，或结果和原计划矛盾：直接升一档')),
        line(t('dim', '「上次」指' + n.basis)),
      ]
    } else if (variant === '2') {
      const q = (question: string, ...answer: any[]) => line(t('plain', question + ' '), ...answer)
      if (s.shift !== null) {
        const sh = s.shift
        if (sh.dir === 'down') {
          const stop = sh.rungs.at(-1)!
          const reached = sh.rungs.filter(passes).at(-1)!
          shiftKids = [
            head(sh),
            q('为什么能降？', t('dim', sh.flag.plain + '（' + pct(sh.flag.p) + '，要 ' + pct(sh.flag.bar) + '）'), ok(true)),
            q('为什么到 ' + sh.to + '？', t('dim', rungName(reached, 'down') + ' 的可能 ' + pct(reached.p) + '（要 ' + pct(reached.bar) + '）'), ok(true)),
            q('为什么不再降？', t('dim', rungName(stop, 'down') + ' 的可能只有 ' + pct(stop.p) + '（要 ' + pct(stop.bar) + '）'), ok(false)),
            q('之后呢？', t('dim', sh.since.replace(/^之后 /, ''))),
          ]
        } else {
          const r = sh.rungs[0]!
          shiftKids = [
            head(sh),
            q('为什么升？', t('dim', sh.flag.plain + '（' + pct(sh.flag.p) + '），这种情况直接升一档')),
            q('难度够升吗？', t('dim', '不够：' + rungName(r, 'up') + ' 的可能 ' + pct(r.p) + '（要 ' + pct(r.bar) + '）'), ok(false)),
            q('之后呢？', t('dim', sh.since.replace(/^之后 /, ''))),
          ]
        }
      }
      nextKids = [
        q('什么时候？', t('dim', n.when + '，这一轮还能换 ' + n.left + ' 次')),
        n.up === null ? q('怎样会升？', t('dim', '已在最高档')) : q('怎样会升到 ' + n.up.level + '？', t('dim', rungName(n.up, 'up') + ' 的可能到 ' + pct(n.up.bar) + '（上次 ' + pct(n.up.p) + '）；或者同一失败又出现、结果和计划矛盾')),
        n.down === null ? q('怎样会降？', t('dim', '已在最低档')) : q('怎样会降到 ' + n.down.level + '？', t('dim', rungName(n.down, 'down') + ' 的可能到 ' + pct(n.down.bar) + '（上次 ' + pct(n.down.p) + '），并且原因已查明或只剩照做')),
      ]
    } else {
      const cols = (a: string, b: string, c: string, mark: any, tone: Tone = 'dim') => line(t(tone, pad(a, 20)), t(tone, pad(b, 6)), t('dim', pad(c, 6)), mark)
      const tableHead = line(t('dim', pad('模型的判断', 20) + pad('估计', 6) + pad('要', 6)))
      if (s.shift !== null) {
        const sh = s.shift
        const rows = sh.dir === 'down'
          ? [
              ...sh.rungs.map((r) => cols(rungName(r, 'down'), pct(r.p), pct(r.bar), passes(r) ? t('ok', r.level === sh.to ? '✓ 到这里' : '✓') : t('dim', '✗ 停'), passes(r) ? 'plain' : 'dim')),
              cols(sh.flag.plain.replace('剩下的只是照已定的做法做完', '剩下只是照做'), pct(sh.flag.p), pct(sh.flag.bar), t('accent', '✓ ' + sh.flag.does), 'plain'),
            ]
          : [
              ...sh.rungs.map((r) => cols(rungName(r, 'up'), pct(r.p), pct(r.bar), t('dim', '✗ 不够升'))),
              cols(sh.flag.plain.replace('同一个失败修过之后又出现了', '同一失败又出现'), pct(sh.flag.p), pct(sh.flag.bar), t('accent', '✓ ' + sh.flag.does), 'plain'),
            ]
        shiftKids = [head(sh), tableHead, ...rows, line(t('dim', sh.since))]
      }
      nextKids = [
        line(t('plain', n.when), t('dim', ' · 还能换 ' + n.left + ' 次')),
        line(t('dim', pad('要满足', 20) + pad('上次', 6) + pad('要', 6))),
        n.up === null ? line(t('dim', '已在最高档')) : cols(rungName(n.up, 'up'), pct(n.up.p), pct(n.up.bar), t('warn', '→ 升到 ' + n.up.level), 'plain'),
        n.down === null ? line(t('dim', '已在最低档')) : cols(rungName(n.down, 'down'), pct(n.down.p), pct(n.down.bar), t('medium', '→ 降到 ' + n.down.level), 'plain'),
        line(t('dim', '降还要：原因已查明，或剩下只是照做')),
        line(t('dim', '直接升一档：同一失败又出现，或结果和计划矛盾')),
      ]
    }

    const header = [
      line(t('dim', 'PROTOTYPE 写法 ' + variant + '（' + VARIANT_NAME[variant] + '）· 场景 ' + scene)),
      line(t('dim', s.title)),
      blank,
      t('accent', '现在'),
      line(lvl(s.level), '  ', t('ok', '✓ 已发出')),
      line(t('dim', s.where)),
      blank,
    ]
    const footer = [blank, t('accent', '上次评估'), line(t('dim', s.last + '（概率条、四道题照旧，略）'))]
    return <Box flexDirection="column">{[...header, box('换挡依据', shiftKids!), box('下次评估', nextKids), ...footer]}</Box>
  })
}
