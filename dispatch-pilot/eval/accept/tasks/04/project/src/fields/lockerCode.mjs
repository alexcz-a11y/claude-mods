// Block letters, a dash, the locker number.
const PATTERN = /^[A-Z]{1,3}-\d{1,4}$/g

export const name = 'lockerCode'
export const hint = 'BC-7'

export function isValid(value) {
  return PATTERN.test(value)
}
