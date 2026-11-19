// Digits with the usual separators; stored as digits only (with the leading + if there was one).
const SHAPE = /^\+?\(?\d[\d ().-]{6,18}\d$/g
const SEPARATORS = /[ ().-]/g

export const name = 'phone'
export const hint = '+00 555 010 2030'

export function isValid(value) {
  return SHAPE.test(value)
}

export function normalize(value) {
  return value.replace(SEPARATORS, '')
}
