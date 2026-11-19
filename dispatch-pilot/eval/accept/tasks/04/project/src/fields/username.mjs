// Starts with a letter; 3 to 16 letters, digits or underscores. Stored in lower case.
const PATTERN = /^[a-z][a-z0-9_]{2,15}$/gi

export const name = 'username'
export const hint = 'ilse_m'

export function isValid(value) {
  return PATTERN.test(value)
}

export function normalize(value) {
  return value.toLowerCase()
}
