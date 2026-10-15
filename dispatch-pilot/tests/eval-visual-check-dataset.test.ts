// The visual-check dataset's format (#65, seam 2's data side): what `eval/validate.ts` accepts and refuses for eval/datasets/visual-check.jsonl.
// Pure: the validator reads parsed JSONL, no disk (that the files an item names are there is checked by eval/validate.ts, which can read them).

import { expect, test } from 'claude-code/testing'
import { validateDataset } from '../eval/lib/datasets.ts'
import { picturesOf } from '../eval/lib/visual-check-items.ts'

const CHECK = { part: 'the primary button', property: 'corner radius' }

/** A well-formed item of each kind; `change` edits a copy. */
function compared(id: string, kind: 'ui' | 'sea', change: (item: any) => void = () => {}): any {
  const item = {
    id,
    kind,
    asked: { screenshot: `${kind}/c1.png`, reference: [`${kind}/ref.png`], same_view: null, checks: [CHECK, { part: 'the tab bar', property: 'number of tabs' }] },
    gold: { holds: [false, true] },
    rationale: '按钮圆角 12 改成 6，标签栏没动。',
    difficulty: 'hard',
    tags: ['corner_radius'],
  }
  change(item)
  return item
}

function anim(id: string, change: (item: any) => void = () => {}): any {
  const item = {
    id,
    kind: 'anim',
    asked: {
      frames: [
        { file: 'anim/spring-00.png', seconds: 0 },
        { file: 'anim/spring-01.png', seconds: 0.05 },
      ],
      spec: 'A card slides in from the left.',
      checks: [{ part: 'the card', property: 'it never moves past its final resting position' }],
    },
    gold: { holds: [false] },
    rationale: '弹簧动画冲过终点再回来。',
    difficulty: 'hard',
    tags: ['spring'],
  }
  change(item)
  return item
}

function complexity(id: string, rank: number, change: (item: any) => void = () => {}): any {
  const item = {
    id,
    kind: 'complexity',
    asked: { references: ['effort/cube-0.png', 'effort/cube-1.png'] },
    gold: { level: 0, accept: [0, 1], rank },
    rationale: '两张立方体的参考图，做起来最简单。',
    difficulty: 'hard',
    tags: ['cube'],
  }
  change(item)
  return item
}

test('a visual-check dataset passes when every item is well formed, with no quota warning', () => {
  const checked = validateDataset('visual-check', [
    compared('ui-c1', 'ui'),
    compared('ui-c9', 'ui', (i) => {
      i.gold.holds = [true, true]
      i.tags = ['control']
      i.difficulty = 'medium'
    }),
    compared('sea-big', 'sea'),
    compared('sea-twin', 'sea', (i) => {
      i.gold.holds = [true, true]
      i.tags = ['control']
      i.difficulty = 'medium'
    }),
    anim('anim-spring'),
    complexity('complexity-cube', 0),
    complexity('complexity-ocean', 1, (i) => (i.gold = { level: 2, accept: [1, 2, 3], rank: 1 })),
  ])
  expect(checked.errors).toEqual([])
  expect(checked.warnings).toEqual([])
})

test('an item says what it asks and what is true of it: no zh and en sides, which a decision model reads in English whatever the person writes', () => {
  const { errors } = validateDataset('visual-check', [compared('ui-c1', 'ui', (i) => (i.zh = { message: '好' })), compared('ui-c2', 'ui', (i) => delete i.asked)])
  expect(errors.join('\n')).toMatch(/ui-c1: unknown field zh/)
  expect(errors.join('\n')).toMatch(/ui-c2: asked is missing/)
})

test('each broken rule of a compared item is reported with the id of the item that breaks it', () => {
  const items = [
    compared('ui-001', 'ui', (i) => (i.asked.reference = [])),
    compared('ui-002', 'ui', (i) => (i.asked.checks = [])),
    compared('ui-003', 'ui', (i) => (i.gold.holds = [false])), // one answer for two checks
    compared('ui-004', 'ui', (i) => (i.asked.checks[0].part = '')),
    compared('ui-005', 'ui', (i) => (i.asked.screenshot = '/abs/c1.png')),
    compared('ui-006', 'ui', (i) => (i.asked.reference = ['ui/../ref.png'])),
    compared('ui-007', 'ui', (i) => (i.asked.same_view = 'yes')),
    compared('ui-008', 'ui', (i) => (i.asked.screenshot = 'ui/c1.jpg')),
    compared('ui-009', 'ui', (i) => (i.gold.holds = [true, true])), // nothing differs and it is not a control
    compared('ui-010', 'ui', (i) => (i.tags = ['control'])), // a control whose gold has a difference
  ]
  const { errors } = validateDataset('visual-check', items)
  const byId = (id: string) => errors.filter((e) => e.startsWith(`${id}:`)).join('\n')
  expect(byId('ui-001')).toMatch(/asked\.reference/)
  expect(byId('ui-002')).toMatch(/asked\.checks/)
  expect(byId('ui-003')).toMatch(/gold\.holds has 1 answers for 2 checks/)
  expect(byId('ui-004')).toMatch(/asked\.checks\[0\]\.part/)
  expect(byId('ui-005')).toMatch(/asked\.screenshot/)
  expect(byId('ui-006')).toMatch(/asked\.reference\[0\]/)
  expect(byId('ui-007')).toMatch(/asked\.same_view/)
  expect(byId('ui-008')).toMatch(/asked\.screenshot/)
  expect(byId('ui-009')).toMatch(/nothing differs.*control/)
  expect(byId('ui-010')).toMatch(/control.*every check holds/)
})

test('a kind of item that is not one of the four is refused, and so is a field it does not have', () => {
  const { errors } = validateDataset('visual-check', [compared('x-1', 'ui', (i) => (i.kind = 'video')), compared('x-2', 'ui', (i) => (i.asked.frames = []))])
  expect(errors.join('\n')).toMatch(/x-1: kind "video" is not one of ui, sea, anim, complexity/)
  expect(errors.join('\n')).toMatch(/x-2: asked has an unknown field frames/)
})

test('an animation item holds at least two frames in order of time, each with its second, and the spec its checks are read against', () => {
  const { errors } = validateDataset('visual-check', [
    anim('anim-1', (i) => (i.asked.frames = [{ file: 'anim/a.png', seconds: 0 }])),
    anim('anim-2', (i) => (i.asked.frames[1].seconds = 0)),
    anim('anim-3', (i) => (i.asked.frames[0].file = 'anim/a.gif')),
    anim('anim-4', (i) => (i.asked.spec = '')),
    anim('anim-5', (i) => i.asked.frames.push(null)),
  ])
  const byId = (id: string) => errors.filter((e) => e.startsWith(`${id}:`)).join('\n')
  expect(byId('anim-1')).toMatch(/asked\.frames/)
  expect(byId('anim-2')).toMatch(/seconds.*order of time/)
  expect(byId('anim-3')).toMatch(/asked\.frames\[0\]\.file/)
  expect(byId('anim-4')).toMatch(/asked\.spec/)
  expect(byId('anim-5')).toMatch(/asked\.frames\[2\]/)
})

test('a complexity item names its reference images (at most six), the level it should read as, the levels that are acceptable, and its place in the order of the groups', () => {
  const { errors } = validateDataset('visual-check', [
    complexity('c-1', 0, (i) => (i.asked.references = [])),
    complexity('c-2', 0, (i) => (i.asked.references = Array.from({ length: 7 }, (_, n) => `effort/c-${n}.png`))),
    complexity('c-3', 0, (i) => (i.gold.level = 5)),
    complexity('c-4', 0, (i) => (i.gold.accept = [1, 2])), // gold not accepted
    complexity('c-5', 0, (i) => (i.gold.accept = [0, 2])), // a gap
    complexity('c-6', 0, (i) => (i.gold.rank = -1)),
    complexity('c-7', 0, (i) => (i.asked.checks = [CHECK])),
  ])
  const byId = (id: string) => errors.filter((e) => e.startsWith(`${id}:`)).join('\n')
  expect(byId('c-1')).toMatch(/asked\.references/)
  expect(byId('c-2')).toMatch(/at most 6/)
  expect(byId('c-3')).toMatch(/gold\.level 5/)
  expect(byId('c-4')).toMatch(/not in gold\.accept/)
  expect(byId('c-5')).toMatch(/not contiguous/)
  expect(byId('c-6')).toMatch(/gold\.rank/)
  expect(byId('c-7')).toMatch(/asked has an unknown field checks/)
})

test('the dataset has quotas of its own: complexity groups in an order of their own, and a control for the compared kinds', () => {
  const { warnings } = validateDataset('visual-check', [compared('ui-c1', 'ui'), complexity('c-a', 0), complexity('c-b', 0)])
  expect(warnings.join('\n')).toMatch(/complexity items share a rank/)
  expect(warnings.join('\n')).toMatch(/no control item among the ui items/)
})

test('the pictures an item names, for the validator that reads the disk: the screenshot and its references, the frames, the references of a group', () => {
  expect(picturesOf(compared('ui-c1', 'ui'))).toEqual(['ui/c1.png', 'ui/ref.png'])
  expect(picturesOf(anim('anim-spring'))).toEqual(['anim/spring-00.png', 'anim/spring-01.png'])
  expect(picturesOf(complexity('c-1', 0))).toEqual(['effort/cube-0.png', 'effort/cube-1.png'])
})
