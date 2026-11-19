// Five digits, optionally followed by a four-digit extension.
const PATTERN = new RegExp('^\\d{5}(-\\d{4})?$', 'g')

export const name = 'postcode'
export const hint = '40212 or 40212-0031'

export function isValid(value) {
  return PATTERN.test(value)
}
