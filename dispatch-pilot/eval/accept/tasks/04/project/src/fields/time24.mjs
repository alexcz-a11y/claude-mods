const PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/g

export const name = 'time24'
export const hint = '18:45'

export function isValid(value) {
  return PATTERN.test(value)
}
