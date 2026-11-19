// Whole units with optional thousands commas and optional cents; stored without the commas.
const SHAPE = /^\d{1,3}(?:,\d{3})*(?:\.\d{2})?$|^\d+(?:\.\d{2})?$/g

export const name = 'amount'
export const hint = '1,250.00'

export function isValid(value) {
  return SHAPE.test(value)
}

export function normalize(value) {
  return value.replace(/,/g, '')
}
