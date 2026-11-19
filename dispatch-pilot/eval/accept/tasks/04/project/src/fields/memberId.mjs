// Member numbers: M- and six digits, as printed on the card.
const PATTERN = /^M-\d{6}$/g

export const name = 'memberId'
export const hint = 'M-004217'

export function isValid(value) {
  return PATTERN.test(value)
}
