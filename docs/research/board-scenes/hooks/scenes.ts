// Probe for looking at dispatch-pilot's board (not part of the mod): it answers the mod's reads of its four state keys
// (session, turn, recent, skills) with one of the board's six fixed scenes, so the real timeline, pane and footer
// draw a turn without any model or decision request. `/dpscene <name>` picks one (README.md says what each shows);
// DP_SCENE=<name> at launch picks the first, `up` otherwise.
//
// scenes-data.ts is dispatch-pilot/tests/support/scenes.ts, copied byte for byte (dispatch-pilot/eval/validate.ts
// fails when the two differ), so the probe shows exactly what the board's tests assert on.

import type { Register, StateRead } from 'claude-code'

import { SCENES } from './scenes-data.ts'

type SceneName = keyof typeof SCENES
type Key = 'session' | 'turn' | 'recent' | 'skills'

const NAMES = Object.keys(SCENES) as SceneName[]
const isScene = (name: string): name is SceneName => (NAMES as string[]).includes(name)

/** The scene shown: the person's last `/dpscene`. A hot reload starts over at DP_SCENE (or `up`). */
let scene: SceneName = 'up'

// The read goes down to the real store first and keeps its version: only the value is the scene's. The mod's own
// writes then still land (an answer with a fixed version would make each of its update()s miss on every try and
// give up), while every read shows the scene.
function sceneRead(key: Key, r: { value: StateRead } | { deny: string }): { value: StateRead } | { deny: string } {
  if (!('value' in r)) return r
  return { value: { value: SCENES[scene][key], version: r.value.version } }
}

const listing = (): string => `场景：${NAMES.join('、')}（现在是 ${scene}）。用 /dpscene <名字> 换一个。`

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const first = await $.env.get('DP_SCENE').catch(() => undefined)
    scene = first !== undefined && isScene(first) ? first : 'up'
    await $.command.register({ name: 'dpscene', description: 'probe: show one of dispatch-pilot\'s board scenes', argumentHint: NAMES.join('|'), immediate: true }).catch(() => undefined)
    return result
  })

  on('command.run', { command: 'dpscene' }, async ($, e) => {
    const want = e.args.trim()
    if (!isScene(want)) return { text: listing(), isTextDisplayOnly: true }
    scene = want
    $.ui.invalidate('ui.render')
    return { text: `场景 ${scene}`, isTextDisplayOnly: true }
  })

  on('state.get', { plugin: 'dispatch-pilot', key: 'session' }, async (_$, e, next) => sceneRead('session', await next(e)))
  on('state.get', { plugin: 'dispatch-pilot', key: 'turn' }, async (_$, e, next) => sceneRead('turn', await next(e)))
  on('state.get', { plugin: 'dispatch-pilot', key: 'recent' }, async (_$, e, next) => sceneRead('recent', await next(e)))
  on('state.get', { plugin: 'dispatch-pilot', key: 'skills' }, async (_$, e, next) => sceneRead('skills', await next(e)))
}
