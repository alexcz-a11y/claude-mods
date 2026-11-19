// Two letters; stored in upper case.
const FLAGS = 'gi'
const PATTERN = new RegExp('^[a-z]{2}$', FLAGS)

export const name = 'countryCode'
export const hint = 'NL'

export function isValid(value) {
  return PATTERN.test(value)
}

export function normalize(value) {
  return value.toUpperCase()
}
