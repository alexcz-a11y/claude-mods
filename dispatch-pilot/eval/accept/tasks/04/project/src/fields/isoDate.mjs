const PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/g
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

export const name = 'isoDate'
export const hint = '2031-03-04'

export function isValid(value) {
  const parts = PATTERN.exec(value)
  if (parts === null) return false
  const month = Number(parts[2])
  const day = Number(parts[3])
  return month >= 1 && month <= 12 && day >= 1 && day <= DAYS_IN_MONTH[month - 1]
}
