// #rgb or #rrggbb; stored as lower-case #rrggbb.
const PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/gi
const SHORT = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/

export const name = 'hexColor'
export const hint = '#0f62fe'

export function isValid(value) {
  return PATTERN.test(value)
}

export function normalize(value) {
  return value.toLowerCase().replace(SHORT, '#$1$1$2$2$3$3')
}
