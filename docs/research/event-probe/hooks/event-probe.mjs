// Observer only: logs the order and payloads of the events around a turn
// (EP#nn lines in the debug log). Every hook passes the event on unchanged.
// Add the event you are asking about; see README.md.

let n = 0
const seq = () => `EP#${String(++n).padStart(2, '0')}`
const cut = (s, k = 300) => {
  const t = typeof s === 'string' ? s : JSON.stringify(s)
  return t === undefined ? 'undefined' : t.length > k ? t.slice(0, k) + `...(+${t.length - k})` : t
}
const keys = (o) => (o && typeof o === 'object' ? Object.keys(o).join(',') : String(o))

export function register(on) {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    try {
      const list = await $.command.list()
      const rows = list.map((c) => `${c.name}=${c.source}${c.plugin ? '/' + c.plugin : ''}`)
      $.ui.log(`${seq()} session.start cmds(${list.length}) ${rows.join(' ')}`, { to: 'debug' })
    } catch (err) {
      $.ui.log(`${seq()} session.start list failed ${String(err)}`, { to: 'debug' })
    }
    return r
  })

  on('prompt.submit', async ($, e, next) => {
    $.ui.log(`${seq()} prompt.submit BEFORE keys=[${keys(e)}] origin=${cut(e.origin)} turnId=${e.turnId} wait=${e.wait} ctx=${e.context ? e.context.length : 'none'} attach=${e.attachments ? e.attachments.length : 'none'} text=${JSON.stringify(cut(e.text))}`, { to: 'debug' })
    const r = await next(e)
    $.ui.log(`${seq()} prompt.submit AFTER keys=[${keys(r)}] drop=${r && r.drop} ctx=${r && r.context ? r.context.length : 'none'} text=${JSON.stringify(cut(r && r.text))}`, { to: 'debug' })
    return r
  })

  on('command.run', async ($, e, next) => {
    $.ui.log(`${seq()} command.run BEFORE keys=[${keys(e)}] command=${e.command} args=${JSON.stringify(cut(e.args))} origin=${cut(e.origin)} presentation=${cut(e.presentation)}`, { to: 'debug' })
    const r = await next(e)
    $.ui.log(`${seq()} command.run AFTER keys=[${keys(r)}] text=${JSON.stringify(cut(r && r.text, 120))} context=${r && r.context ? 'yes:' + cut(r.context, 120) : 'none'} ref=${r && r.ref}`, { to: 'debug' })
    return r
  })

  on('skill.prompt', async ($, e, next) => {
    $.ui.log(`${seq()} skill.prompt BEFORE skill=${e.skill} keys=[${keys(e)}] len=${e.text.length} text=${JSON.stringify(cut(e.text))}`, { to: 'debug' })
    const r = await next(e)
    $.ui.log(`${seq()} skill.prompt AFTER len=${r && r.text ? r.text.length : 'none'}`, { to: 'debug' })
    return r
  })

  on('turn.start', async ($, e, next) => {
    $.ui.log(`${seq()} turn.start BEFORE keys=[${keys(e)}] turnId=${e.turnId} text=${JSON.stringify(cut(e.text))}`, { to: 'debug' })
    const r = await next(e)
    $.ui.log(`${seq()} turn.start AFTER ${cut(r)}`, { to: 'debug' })
    return r
  })

  on('turn.step', async function* ($, e, next) {
    $.ui.log(`${seq()} turn.step turnId=${e.turnId} index=${e.index} model=${e.model} effort=${e.effort} msgs=${e.messageCount} agentId=${e.agentId}`, { to: 'debug' })
    return yield* next(e)
  })

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    $.ui.log(`${seq()} tool.call(Agent) BEFORE tool_use_id=${e.tool_use_id} background=${e.run_in_background} agentId=${e.agentId}`, { to: 'debug' })
    const r = await next(e)
    $.ui.log(`${seq()} tool.call(Agent) AFTER keys=[${keys(r)}] context=${r && r.context ? r.context.length : 'none'} text=${JSON.stringify(cut(r && r.text, 160))}`, { to: 'debug' })
    return r
  })

  on('agent.spawn', async ($, e, next) => {
    $.ui.log(`${seq()} agent.spawn BEFORE tool_use_id=${e.tool_use_id} background=${e.background} model=${e.model} type=${e.subagentType}`, { to: 'debug' })
    const r = await next(e)
    $.ui.log(`${seq()} agent.spawn AFTER agentId=${r && r.agentId} model=${r && r.model}`, { to: 'debug' })
    return r
  })

  on('turn.complete', async ($, e, next) => {
    $.ui.log(`${seq()} turn.complete keys=[${keys(e)}] ${cut(e, 200)}`, { to: 'debug' })
    return next(e)
  })

  on('session.append', async ($, e, next) => {
    const m = e.message || {}
    const first = Array.isArray(m.content) && m.content[0] && typeof m.content[0].text === 'string' ? m.content[0].text : ''
    const skip = e.door === 'attachment' && !['command_output', 'invoked_skills', 'skill_listing_x'].includes(m.name) && !String(m.name).includes('command') && !String(m.name).includes('skill')
    if (!skip || m.name === undefined) {
      $.ui.log(`${seq()} session.append type=${m.type} name=${m.name} door=${e.door} origin=${cut(e.origin, 120)} text=${JSON.stringify(cut(first, 200))}`, { to: 'debug' })
    }
    return next(e)
  })
}
