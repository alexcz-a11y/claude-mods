// Two blocks of four capitals or digits.
const CODE = /[A-Z0-9]{4}-[A-Z0-9]{4}/y

export const name = 'referral'
export const hint = 'K7QM-22XA'

export function isValid(value) {
  return value.length === 9 && CODE.test(value)
}
