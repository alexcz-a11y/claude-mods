// y, yes, n or no in any case; stored as yes or no.
const PATTERN = /^(?:y|yes|n|no)$/gi

export const name = 'yesNo'
export const hint = 'yes or no'

export function isValid(value) {
  return PATTERN.test(value)
}

export function normalize(value) {
  return value.toLowerCase().startsWith('y') ? 'yes' : 'no'
}
