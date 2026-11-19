const PATTERN = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/gi

export const name = 'email'
export const hint = 'name@example.org'

export function isValid(value) {
  return value.length <= 254 && PATTERN.test(value)
}

export function normalize(value) {
  return value.toLowerCase()
}
