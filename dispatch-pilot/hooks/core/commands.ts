// Command turns (#19): which prompt the person started with a prompt command
// (a skill, a markdown command, an MCP prompt). The engine runs the command
// (`command.run`, the core notes it) just before it submits the prompt as
// typed (`/name args`); a local command (`/dp`, `/clear`) submits nothing,
// so its note waits until the next command takes its place (measured on
// 2.1.291). A prompt that only starts with a slash (`/Users/...`) matches no
// note: it is an ordinary message.
//
// Pure module state: lost on a hot reload, which only costs the command turn
// of a prompt submitted during that reload (it is routed as a plain message).

import { clipToTokens } from '../decision/context.ts'
import { profileFields, type SkillOption } from '../decision/skills.ts'

/** A command the person ran: its name as the engine resolved it, and everything typed after it. */
export type RanCommand = { command: string; args: string }

/** The last command run: the next prompt may be its turn. */
let noted: RanCommand | null = null

/** The engine is about to run this command (core's `command.run`). */
export function noteCommand(ran: RanCommand): void {
  noted = { command: ran.command, args: ran.args }
}

/**
 * The command this prompt was submitted for, when it is a command turn: its
 * first word is the command last run (a plugin's command typed without its
 * plugin's name, or with it, too). Null for any other prompt. Asking does not use it up.
 */
export function commandOf(text: string): RanCommand | null {
  if (noted === null) return null
  const typed = /^\/(\S+)/.exec(text.trimStart())?.[1]
  if (typed === undefined) return null
  return typed === noted.command || noted.command.endsWith(`:${typed}`) || typed.endsWith(`:${noted.command}`) ? noted : null
}

/**
 * The command as the person typed it (`/name args`), from the message a
 * command turn starts with: the engine wraps the command in
 * `<command-message>`, `<command-name>` and `<command-args>` (turn.start's
 * text; measured on 2.1.291). Null for any other text.
 */
export function typedCommand(text: string): string | null {
  const name = /<command-name>(\/[^<]*)<\/command-name>/.exec(text)?.[1]
  if (name === undefined || !text.trimStart().startsWith('<command-message>')) return null
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1] ?? ''
  return args === '' ? name : `${name} ${args}`
}

/** The command turn's prompt has entered (core's `prompt.submit`): the note is used up. */
export function forgetCommand(text: string): void {
  if (commandOf(text) !== null) noted = null
}

/** A command's description is cut to this many tokens: what it is for is said at its start. */
export const COMMAND_TOKENS = 150

/**
 * What the decision model reads about a command turn's command, beside the
 * command as typed (`command` in the state; never the prompt it expands to):
 * its skill's profile in brief, both languages, when one is written, else
 * its description (the skill's, or `$.command.list()`'s). Null when neither
 * is known.
 */
export function commandState(name: string, skill: SkillOption | undefined, listed: string | undefined): Readonly<Record<string, string>> | null {
  if (skill?.profile) return { name, ...profileFields(skill.profile, true) }
  const description = (skill?.description || listed || '').trim()
  return description === '' ? null : { name, description: clipToTokens(description, COMMAND_TOKENS) }
}
