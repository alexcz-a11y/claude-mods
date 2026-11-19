// Lower-case words separated by semicolons; stored in alphabetical order.
const LIST = /^[a-z]+(?:;[a-z]+)*$/g
const WORD = /[a-z]+/g

export const name = 'tags'
export const hint = 'chess;rowing'

export function isValid(value) {
  return LIST.test(value)
}

export function normalize(value) {
  return [...value.matchAll(WORD)].map((match) => match[0]).sort().join(';')
}
