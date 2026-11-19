// 8-4-4-12 hex digits; stored in lower case.
const HEX = '[0-9a-f]'
const PATTERN = new RegExp(`^${HEX}{8}-${HEX}{4}-${HEX}{4}-${HEX}{12}$`, 'gi')

export const name = 'deviceId'
export const hint = '3f2a9c1e-77b0-4d2a-9c1e5a7b3d10'

export function isValid(value) {
  return PATTERN.test(value)
}

export function normalize(value) {
  return value.toLowerCase()
}
