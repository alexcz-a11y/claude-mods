// Any non-empty text up to 80 characters; stored with single spaces.
export const name = 'name'
export const hint = 'Ilse Marrow'

export function isValid(value) {
  return value.trim().length > 0 && value.length <= 80
}

export function normalize(value) {
  return value.trim().replace(/\s+/g, ' ')
}
