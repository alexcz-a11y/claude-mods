export const name = 'birthYear'
export const hint = '1988'

export function isValid(value) {
  if (!/^\d{4}$/.test(value)) return false
  const year = Number(value)
  return year >= 1900 && year <= 2030
}
