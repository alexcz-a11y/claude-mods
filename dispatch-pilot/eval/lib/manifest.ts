// The plugin's options as the manifest declares them, held to the code and to what the user reads in the configuration
// (amendment A17, Ruling C44): every key read by readConfig and every option of Config declared; each option but the
// keys a switch or a picker, since /plugin's Configure shows a default only for those (measured on 2.1.328); each
// default and each choice read by the code as written; a short title and description. Pure: eval/validate.ts runs it on
// the real manifest, the tests on made-up ones.
import { OPTION_BARS, optionKey, readConfig } from '../../hooks/config.ts'
import type { Config } from '../../hooks/config.ts'

/** /config shows the title alone on the option's row, so it stays short. */
export const TITLE_MAX = 14
/** The help text under the field: at most two short sentences (the user's "简短简单明了"). */
export const DESCRIPTION_MAX = 70
/** The engine's bound on a picker's label. */
const LABEL_MAX = 64

type Spec = Record<string, unknown>

// The value an option takes in a Config (agentModels as the comma list a picker writes); undefined: none.
function valueOf(cfg: Config, key: string): unknown {
  if (key !== 'bars' && key in cfg) {
    const v = (cfg as unknown as Record<string, unknown>)[key]
    return Array.isArray(v) ? v.join(',') : v
  }
  for (const [group, fields] of Object.entries(OPTION_BARS)) {
    for (const field of fields) if (optionKey(group, field) === key) return (cfg.bars as unknown as Record<string, Record<string, number>>)[group]![field]
  }
  return undefined
}

const shown = (v: unknown): string => JSON.stringify(v)
// What a picker's label means to the code: a number option's label is its number.
const meant = (label: string, code: unknown): unknown => (typeof code === 'number' ? Number(label) : label)

function specProblems(key: string, spec: Spec, base: Config, baseText: string): string[] {
  const out: string[] = []
  if (typeof spec.title !== 'string' || spec.title.trim() === '') out.push(`${key}: no title`)
  else if (spec.title.length > TITLE_MAX) out.push(`${key}: the title is ${spec.title.length} characters, more than ${TITLE_MAX}`)
  if (typeof spec.description !== 'string' || spec.description.trim() === '') out.push(`${key}: no description`)
  else if (spec.description.length > DESCRIPTION_MAX) out.push(`${key}: the description is ${spec.description.length} characters, more than ${DESCRIPTION_MAX}`)
  const code = valueOf(base, key)
  if (code === undefined) return [...out, `${key}: readConfig has no field for it`]
  if (!('default' in spec)) return [...out, `${key}: no default`]
  const def = spec.default
  let probes: unknown[]
  if (spec.sensitive === true) {
    if (def !== code) out.push(`${key}: the default ${shown(def)} is not readConfig({})'s ${shown(code)}`)
    probes = ['probe-value']
  } else if (typeof code === 'boolean') {
    if (spec.type !== 'boolean' || typeof def !== 'boolean') out.push(`${key}: a switch whose type or default is not boolean`)
    else if (def !== code) out.push(`${key}: the default ${shown(def)} is not readConfig({})'s ${shown(code)}`)
    probes = [!code]
  } else {
    const options = spec.options
    if (spec.type !== 'string' || !Array.isArray(options) || options.length === 0 || !options.every((o) => typeof o === 'string')) {
      return [...out, `${key}: no options, so /plugin shows no default; make it a picker`]
    }
    const labels = options as string[]
    if (typeof def !== 'string' || !labels.includes(def)) out.push(`${key}: the default ${shown(def)} is not one of its options`)
    else if (meant(def, code) !== code) out.push(`${key}: the default ${shown(def)} is not readConfig({})'s ${shown(code)}`)
    for (const label of labels) {
      if (label.length < 1 || label.length > LABEL_MAX) out.push(`${key}: the choice ${shown(label)} is not 1 to ${LABEL_MAX} characters`)
      const read = valueOf(readConfig({ [key]: label }), key)
      if (read !== meant(label, code)) out.push(`${key}: the choice ${shown(label)} reads as ${shown(read)}`)
    }
    probes = [...labels, 'probe-value']
  }
  if (!probes.some((v) => JSON.stringify(readConfig({ [key]: v })) !== baseText)) out.push(`${key}: readConfig does not read it`)
  return out
}

/** What is wrong with these userConfig entries, one line each; empty when nothing is. */
export function optionProblems(userConfig: Record<string, unknown>): string[] {
  const base = readConfig({})
  const baseText = JSON.stringify(base)
  const out: string[] = []
  for (const [key, raw] of Object.entries(userConfig)) out.push(...specProblems(key, raw !== null && typeof raw === 'object' ? (raw as Spec) : {}, base, baseText))
  const keys = [
    ...Object.keys(base).filter((k) => k !== 'bars'),
    ...Object.entries(OPTION_BARS).flatMap(([group, fields]) => fields.map((f) => optionKey(group, f))),
  ]
  for (const key of keys) if (!(key in userConfig)) out.push(`${key}: a Config field with no option`)
  return out
}
