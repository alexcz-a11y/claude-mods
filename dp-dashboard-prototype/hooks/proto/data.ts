// PROTOTYPE data: everything here is fake and lives in memory.
// The decision lines are shaped after the owner's real `/dp log` output.

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
export type Model = 'haiku' | 'sonnet' | 'opus' | 'fable'
export type AState = 'running' | 'done' | 'failed' | 'queued'
export type Probs = Record<Effort, number>

export interface Esc {
  failed: number
  blocked: number
  raised: number
  from: Effort
  to: Effort
}

export interface Node {
  n?: number // decision number in the log; queued Workflow agents have none yet
  kind: 'agent' | 'wf'
  name: string
  type: string
  model?: Model // queued Workflow agents are not routed yet
  effort?: Effort
  state: AState
  t0: number // seconds from the turn start to the agent start
  dur?: number // seconds the agent ran, when finished
  conf?: number
  probs?: Probs
  reason: string
  esc?: Esc
  routed: boolean
  why?: string // why it was not routed, or why it failed
}

export type MainSrc = 'decided' | 'locked' | 'notrouted'

export interface Scene {
  key: SceneKey
  label: string
  turn: number
  prompt: string
  now: number // seconds since the turn started, when the scene begins
  done: boolean // the turn is over (no running agents)
  main: {
    n?: number
    effort: Effort
    src: MainSrc
    conf?: number
    probs?: Probs
    reason: string
    step?: string // the latest mid-turn re-decision, e.g. "第 6 步 保持"
  }
  agents: Node[]
  wf?: { name: string; agents: Node[] }
  skills: { name: string; fit: number }[]
}

export type SceneKey = 'idle' | 'running' | 'agents' | 'workflow' | 'stuck' | 'notrouted' | 'many'
export const SCENE_KEYS: readonly SceneKey[] = ['running', 'agents', 'workflow', 'stuck', 'notrouted', 'many', 'idle']

const P = (low: number, medium: number, high: number, xhigh: number, max: number): Probs => ({ low, medium, high, xhigh, max })

const PROMPT7 = '目前状态栏那个三角形感叹号为什么一直在'
const SKILLS7 = [
  { name: 'research', fit: 0.86 },
  { name: 'plugin-authoring', fit: 0.8 },
]

// -- dispatched agents ------------------------------------------------------

const a20 = (over: Partial<Node> = {}): Node => ({
  n: 20, kind: 'agent', name: 'Research mod UI surfaces', type: 'general-purpose',
  model: 'sonnet', effort: 'medium', state: 'done', t0: 6, dur: 41, routed: true,
  conf: 0.4, probs: P(0.53, 0.2, 0.11, 0.16, 0),
  reason: '通用调研，选 sonnet',
  ...over,
})
const a27: Node = {
  n: 27, kind: 'agent', name: 'Grep dispatch-pilot hooks', type: 'Explore',
  model: 'haiku', effort: 'low', state: 'done', t0: 9, dur: 7, routed: true,
  conf: 0.71, probs: P(0.64, 0.22, 0.09, 0.04, 0.01),
  reason: '只读检索，选 haiku；effort low',
}
const a28 = (over: Partial<Node> = {}): Node => ({
  n: 28, kind: 'agent', name: 'Review ADR drafts', type: 'general-purpose',
  model: 'opus', effort: 'xhigh', state: 'running', t0: 31, routed: true,
  conf: 0.66, probs: P(0.02, 0.07, 0.19, 0.66, 0.06),
  reason: '需要跨文档判断，选 opus；xhigh 概率 0.66',
  ...over,
})
const a29 = (over: Partial<Node> = {}): Node => ({
  n: 29, kind: 'agent', name: 'Write migration tests', type: 'general-purpose',
  model: 'sonnet', effort: 'xhigh', state: 'running', t0: 48, routed: true,
  conf: 0.52, probs: P(0.07, 0.18, 0.44, 0.27, 0.04),
  reason: '起步 high（0.44）；工具连续失败后被提升到 xhigh',
  esc: { failed: 2, blocked: 1, raised: 1, from: 'high', to: 'xhigh' },
  ...over,
})
const a31: Node = {
  n: 31, kind: 'agent', name: 'Draft release notes', type: 'general-purpose',
  model: 'fable', effort: 'medium', state: 'running', t0: 63, routed: true,
  conf: 0.58, probs: P(0.1, 0.52, 0.28, 0.09, 0.01),
  reason: '面向读者的写作，选 fable；effort medium',
}
const a32: Node = {
  n: 32, kind: 'agent', name: 'Probe Desktop renderer', type: 'general-purpose',
  model: 'sonnet', effort: 'high', state: 'failed', t0: 52, dur: 12, routed: true,
  conf: 0.49, probs: P(0.08, 0.2, 0.46, 0.22, 0.04),
  reason: '选 sonnet，effort high',
  why: 'Bash 连续失败 2 次，已放弃',
}

// -- workflow agents --------------------------------------------------------

const WF = 'mod-ui-surfaces-research'
const w = (n: number | undefined, name: string, model: Model | undefined, effort: Effort | undefined, state: AState, t0: number, dur: number | undefined, conf: number | undefined, probs: Probs | undefined, reason: string): Node => ({
  n, kind: 'wf', name, type: 'workflow', model, effort, state, t0, dur, conf, probs, reason, routed: model !== undefined,
})
const wfAgents: Node[] = [
  w(25, 'sweep:types', 'sonnet', 'xhigh', 'done', 12, 24, 0.79, P(0.06, 0.14, 0.27, 0.48, 0.05), '选 sonnet，置信 0.79；xhigh 概率 0.48'),
  w(27, 'sweep:docs', 'sonnet', 'high', 'done', 12, 19, 0.74, P(0.05, 0.16, 0.5, 0.26, 0.03), '文档扫描，选 sonnet；high 概率 0.50'),
  w(28, 'sweep:probes', 'haiku', 'medium', 'done', 12, 11, 0.68, P(0.18, 0.46, 0.25, 0.1, 0.01), '探针清单整理，选 haiku；medium'),
  w(29, 'sweep:desktop', 'sonnet', 'high', 'done', 13, 27, 0.72, P(0.04, 0.13, 0.52, 0.27, 0.04), '选 sonnet；high 概率 0.52'),
  w(30, 'sweep:terminal', 'sonnet', 'high', 'done', 13, 31, 0.7, P(0.03, 0.15, 0.49, 0.29, 0.04), '选 sonnet；high 概率 0.49'),
  w(26, 'verify:cross-check', 'opus', 'xhigh', 'running', 40, undefined, 0.71, P(0.03, 0.08, 0.18, 0.62, 0.09), '交叉核对多份结论，选 opus；xhigh 概率 0.62'),
  w(31, 'verify:claims', 'opus', 'high', 'running', 44, undefined, 0.64, P(0.02, 0.1, 0.55, 0.3, 0.03), '逐条核对论断，选 opus；high 概率 0.55'),
  w(undefined, 'synthesize', undefined, undefined, 'queued', 0, undefined, undefined, undefined, '等 verify 阶段结束后再决定'),
]

// -- a stress scene: many dispatched agents ---------------------------------

const ag = (n: number, name: string, model: Model, effort: Effort, state: AState, t0: number, dur: number | undefined, conf: number, extra: Partial<Node> = {}): Node => ({
  n, kind: 'agent', name, type: 'general-purpose', model, effort, state, t0, dur, conf, routed: true,
  probs: P(0.1, 0.2, 0.3, 0.3, 0.1), reason: `选 ${model}；${effort} 概率较高`, ...extra,
})
const manyAgents: Node[] = [
  ag(40, 'Map status call sites', 'haiku', 'low', 'done', 8, 9, 0.7),
  ag(41, 'Read core/status.ts', 'haiku', 'low', 'done', 8, 5, 0.72),
  ag(42, 'Read features/*.ts', 'haiku', 'low', 'done', 9, 14, 0.68),
  ag(43, 'Draft module interface', 'opus', 'xhigh', 'done', 30, 51, 0.66),
  ag(44, 'Write types', 'sonnet', 'high', 'running', 84, undefined, 0.6),
  ag(45, 'Write status tests', 'sonnet', 'high', 'running', 86, undefined, 0.55, {
    effort: 'xhigh', esc: { failed: 2, blocked: 0, raised: 1, from: 'high', to: 'xhigh' },
  }),
  ag(46, 'Port effort segment', 'sonnet', 'medium', 'running', 90, undefined, 0.58),
  ag(47, 'Port skills segment', 'sonnet', 'medium', 'running', 90, undefined, 0.57),
  ag(48, 'Update README', 'fable', 'low', 'running', 101, undefined, 0.5),
  ag(49, 'Run eslint', 'haiku', 'low', 'failed', 104, 12, 0.7, { why: 'eslint 退出码 2，已放弃' }),
  ag(50, 'Review diff', 'opus', 'xhigh', 'running', 118, undefined, 0.64),
]

// -- scenes -----------------------------------------------------------------

const main7 = { n: 23 as number | undefined,effort: 'xhigh' as Effort, src: 'decided' as MainSrc, conf: 0.25, probs: P(0.23, 0.02, 0.12, 0.59, 0.04), reason: 'xhigh 概率 0.59，置信偏低，仍取最可能档位' }

export const SCENES: Record<SceneKey, Scene> = {
  idle: {
    key: 'idle', label: '空闲（上一轮刚结束）', turn: 7, prompt: PROMPT7, now: 118, done: true,
    main: { ...main7, step: '第 6 步 保持' },
    agents: [a20(), a27, a28({ state: 'done', dur: 52 }), a29({ state: 'done', dur: 47 }), { ...a31, state: 'done', dur: 44 }],
    skills: SKILLS7,
  },
  running: {
    key: 'running', label: '刚开始跑', turn: 7, prompt: PROMPT7, now: 14, done: false,
    main: main7,
    agents: [a20({ state: 'running', dur: undefined })],
    skills: SKILLS7,
  },
  agents: {
    key: 'agents', label: '多个 agent', turn: 7, prompt: PROMPT7, now: 94, done: false,
    main: { ...main7, step: '第 4 步 保持' },
    agents: [a20(), a27, a28(), a29(), a31, a32],
    skills: SKILLS7,
  },
  workflow: {
    key: 'workflow', label: 'Workflow 进行中', turn: 7, prompt: PROMPT7, now: 71, done: false,
    main: { effort: 'xhigh', src: 'locked', reason: '你用 /effort 锁定了 xhigh，本轮不再路由' },
    agents: [a27],
    wf: { name: WF, agents: wfAgents },
    skills: [{ name: 'research', fit: 0.86 }],
  },
  stuck: {
    key: 'stuck', label: '卡住并升级', turn: 7, prompt: PROMPT7, now: 118, done: false,
    main: { ...main7, step: '第 6 步 保持' },
    agents: [
      a28({ state: 'done', dur: 52 }),
      a29(),
      a32,
      a31,
    ],
    skills: SKILLS7,
  },
  notrouted: {
    key: 'notrouted', label: '未路由', turn: 8, prompt: '/ask-matt 这个状态栏该怎么改', now: 21, done: false,
    main: { n: 35, effort: 'xhigh', src: 'notrouted', reason: '斜杠命令开头的消息不走路由' },
    agents: [
      {
        n: undefined, kind: 'agent', name: 'Check marketplace manifest', type: 'general-purpose',
        model: 'opus', effort: 'xhigh', state: 'running', t0: 8, routed: false,
        reason: '路由失败：沿用主 agent 的模型和 effort', why: 'jev: no answer in 1500 ms',
      },
      {
        n: 36, kind: 'agent', name: 'Grep dispatch-pilot hooks', type: 'Explore',
        model: 'haiku', effort: 'low', state: 'done', t0: 5, dur: 7, routed: true,
        conf: 0.71, probs: P(0.64, 0.22, 0.09, 0.04, 0.01), reason: '只读检索，选 haiku；effort low',
      },
    ],
    skills: [],
  },
  many: {
    key: 'many', label: '11 个 agent', turn: 9, prompt: '把 hooks 里的 status 逻辑拆成独立模块并补测试', now: 140, done: false,
    main: { n: 39, effort: 'xhigh', src: 'decided', conf: 0.52, probs: P(0.04, 0.08, 0.2, 0.62, 0.06), reason: 'xhigh 概率 0.62' },
    agents: manyAgents,
    skills: [{ name: 'tdd', fit: 0.82 }, { name: 'codebase-design', fit: 0.78 }],
  },
}

// -- the decision log (what /dp log would print) ----------------------------

export type Tone = 'ok' | 'warn' | 'fail' | 'info'
export interface LogEntry {
  n: number
  turn: number
  feature: string
  tone: Tone
  outcome: string // short Chinese verb, shown bold
  subject: string // what it was about
  pick?: { model?: Model; effort?: Effort }
  reason: string
  probs?: Probs
  conf?: number
  fits?: { name: string; fit: number }[]
  /** a model floor that lifted the decided effort (variant D's rule trace) */
  floor?: { from: Effort; to: Effort; model: Model }
  /** a mid-turn re-decision: the answer's pick against the level the turn was at (variant D) */
  mid?: { current: Effort; picked: Effort; result: Effort; held?: string }
}

/** Thresholds as dispatch-pilot's README gives them for Jev (variant D's rule trace). */
export const RULES = { thetaMax: 0.5, roundUp: 0.3, thetaUp: 0.3, thetaDown: 0.55, holdSteps: 5 }

export const TURNS: { turn: number; prompt: string }[] = [
  { turn: 6, prompt: '调研 mod 在终端和 Desktop 怎么画界面' },
  { turn: 7, prompt: PROMPT7 },
  { turn: 8, prompt: '/ask-matt 这个状态栏该怎么改' },
]

export const LOG: LogEntry[] = [
  { n: 18, turn: 6, feature: 'main-effort', tone: 'ok', outcome: '已决定', subject: '“调研 mod 在终端和 Desktop 怎么画界面”', pick: { effort: 'xhigh' }, probs: P(0.04, 0.06, 0.16, 0.68, 0.06), conf: 0.62, reason: 'xhigh 概率 0.68，明显最高' },
  { n: 19, turn: 6, feature: 'skills', tone: 'info', outcome: '已建议', subject: 'research、plugin-authoring', reason: '相关度达到 0.75 的才建议', fits: [{ name: 'research', fit: 0.88 }, { name: 'plugin-authoring', fit: 0.83 }, { name: 'grill-with-docs', fit: 0.41 }] },
  { n: 20, turn: 6, feature: 'dispatched-agents', tone: 'ok', outcome: '已决定', subject: '“Research mod UI surfaces”（general-purpose）', pick: { model: 'sonnet', effort: 'medium' }, probs: P(0.53, 0.2, 0.11, 0.16, 0), conf: 0.4, reason: '选 sonnet；effort 由 low 抬到 medium（sonnet 的下限）', floor: { from: 'low', to: 'medium', model: 'sonnet' } },
  { n: 21, turn: 6, feature: 'midturn-effort', tone: 'ok', outcome: '升档', subject: '第 2 步（Agent）', pick: { effort: 'xhigh' }, probs: P(0.08, 0.12, 0.07, 0.72, 0.01), conf: 0.55, reason: '建议高于当前，置信够升档线', mid: { current: 'high', picked: 'xhigh', result: 'xhigh' } },
  { n: 22, turn: 6, feature: 'midturn-effort', tone: 'ok', outcome: '保持', subject: '第 5 步（Read）', pick: { effort: 'xhigh' }, probs: P(0.05, 0.1, 0.14, 0.66, 0.05), conf: 0.49, reason: '与当前档位相同，不改', mid: { current: 'xhigh', picked: 'xhigh', result: 'xhigh' } },

  { n: 23, turn: 7, feature: 'main-effort', tone: 'ok', outcome: '已决定', subject: `“${PROMPT7}…”`, pick: { effort: 'xhigh' }, probs: P(0.23, 0.02, 0.12, 0.59, 0.04), conf: 0.25, reason: 'xhigh 概率 0.59，置信偏低，仍取最可能档位' },
  { n: 24, turn: 7, feature: 'skills', tone: 'info', outcome: '已建议', subject: 'research、plugin-authoring', reason: '相关度达到 0.75 的才建议', fits: [{ name: 'research', fit: 0.86 }, { name: 'plugin-authoring', fit: 0.8 }, { name: 'grill-with-docs', fit: 0.46 }] },
  { n: 25, turn: 7, feature: 'workflow-agents', tone: 'ok', outcome: '已决定', subject: `“sweep:types”（Workflow ${WF}）`, pick: { model: 'sonnet', effort: 'xhigh' }, probs: P(0.06, 0.14, 0.27, 0.48, 0.05), conf: 0.79, reason: '选 sonnet' },
  { n: 26, turn: 7, feature: 'workflow-agents', tone: 'ok', outcome: '已决定', subject: `“verify:cross-check”（Workflow ${WF}）`, pick: { model: 'opus', effort: 'xhigh' }, probs: P(0.03, 0.08, 0.18, 0.62, 0.09), conf: 0.71, reason: '选 opus' },
  { n: 27, turn: 7, feature: 'dispatched-agents', tone: 'ok', outcome: '已决定', subject: '“Grep dispatch-pilot hooks”（Explore）', pick: { model: 'haiku', effort: 'low' }, probs: P(0.64, 0.22, 0.09, 0.04, 0.01), conf: 0.71, reason: '只读检索，选 haiku' },
  { n: 28, turn: 7, feature: 'dispatched-agents', tone: 'ok', outcome: '已决定', subject: '“Review ADR drafts”（general-purpose）', pick: { model: 'opus', effort: 'xhigh' }, probs: P(0.02, 0.07, 0.19, 0.66, 0.06), conf: 0.66, reason: '需要跨文档判断，选 opus' },
  { n: 29, turn: 7, feature: 'dispatched-agents', tone: 'ok', outcome: '已决定', subject: '“Write migration tests”（general-purpose）', pick: { model: 'sonnet', effort: 'high' }, probs: P(0.07, 0.18, 0.44, 0.27, 0.04), conf: 0.52, reason: '选 sonnet；起步 high' },
  { n: 30, turn: 7, feature: 'escalation', tone: 'warn', outcome: '已提升', subject: '“Write migration tests”：失败 2、阻塞 1、提升 1', pick: { effort: 'xhigh' }, reason: 'effort 由 high 提到 xhigh（一档）' },
  { n: 31, turn: 7, feature: 'dispatched-agents', tone: 'ok', outcome: '已决定', subject: '“Draft release notes”（general-purpose）', pick: { model: 'fable', effort: 'medium' }, probs: P(0.1, 0.52, 0.28, 0.09, 0.01), conf: 0.58, reason: '面向读者的写作，选 fable' },
  { n: 32, turn: 7, feature: 'dispatched-agents', tone: 'ok', outcome: '已决定', subject: '“Probe Desktop renderer”（general-purpose）', pick: { model: 'sonnet', effort: 'high' }, probs: P(0.08, 0.2, 0.46, 0.22, 0.04), conf: 0.49, reason: '选 sonnet；该 agent 之后失败（Bash 连续失败 2 次）' },
  { n: 33, turn: 7, feature: 'midturn-effort', tone: 'ok', outcome: '保持', subject: '第 6 步（Edit）', pick: { effort: 'high' }, probs: P(0.09, 0.14, 0.48, 0.25, 0.04), conf: 0.42, reason: '建议低于当前，但置信不到降档线', mid: { current: 'xhigh', picked: 'high', result: 'xhigh' } },
  { n: 34, turn: 7, feature: 'midturn-effort', tone: 'ok', outcome: '保持', subject: '第 9 步（Bash）', pick: { effort: 'medium' }, probs: P(0.1, 0.62, 0.2, 0.07, 0.01), conf: 0.71, reason: '刚升过档，5 步内不降', mid: { current: 'xhigh', picked: 'medium', result: 'xhigh', held: '还差 3 步' } },

  { n: 35, turn: 8, feature: 'main-effort', tone: 'warn', outcome: '未路由', subject: '“/ask-matt 这个状态栏该怎么改”', pick: { effort: 'xhigh' }, reason: '斜杠命令开头的消息不走路由；沿用当前 xhigh' },
  { n: 36, turn: 8, feature: 'dispatched-agents', tone: 'ok', outcome: '已决定', subject: '“Grep dispatch-pilot hooks”（Explore）', pick: { model: 'haiku', effort: 'low' }, probs: P(0.64, 0.22, 0.09, 0.04, 0.01), conf: 0.71, reason: '只读检索，选 haiku' },
  { n: 37, turn: 8, feature: 'dispatched-agents', tone: 'fail', outcome: '路由失败', subject: '“Check marketplace manifest”（general-purpose）', reason: 'jev: no answer in 1500 ms；沿用主 agent 的 opus · xhigh' },
]

// -- helpers over the data --------------------------------------------------

export interface Ev {
  t: number
  kind: 'main' | 'skills' | 'start' | 'raise' | 'wf'
  node?: Node
  text?: string
}

/** All nodes of a scene in display order: dispatched agents, then the Workflow's agents. */
export function allNodes(s: Scene): Node[] {
  return [...s.agents, ...(s.wf?.agents ?? [])]
}

export function counts(nodes: Node[]) {
  const c = { running: 0, done: 0, failed: 0, queued: 0, total: nodes.length, esc: 0, notRouted: 0 }
  for (const n of nodes) {
    c[n.state] += 1
    if (n.esc) c.esc += 1
    if (!n.routed && n.model !== undefined) c.notRouted += 1
  }
  return c
}

/** The turn's events up to `now` (scene start plus the live seconds), oldest first. */
export function events(s: Scene, live: number): Ev[] {
  const now = s.now + live
  const out: Ev[] = [{ t: 0.4, kind: 'main' }]
  if (s.skills.length > 0) out.push({ t: 1.2, kind: 'skills' })
  if (s.wf) out.push({ t: 11, kind: 'wf', text: s.wf.name })
  for (const n of allNodes(s)) {
    if (n.state === 'queued') continue
    out.push({ t: n.t0, kind: 'start', node: n })
    if (n.esc) out.push({ t: n.t0 + 22, kind: 'raise', node: n })
  }
  return out.filter((e) => e.t <= now).sort((a, b) => a.t - b.t)
}
