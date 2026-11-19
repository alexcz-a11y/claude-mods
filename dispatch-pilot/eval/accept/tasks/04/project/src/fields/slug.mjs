// Lower-case words and numbers joined by single dashes.
const PATTERN = new RegExp('^[a-z0-9]+(?:-[a-z0-9]+)*$', 'g')

export const name = 'slug'
export const hint = 'ilse-marrow'

export function isValid(value) {
  return value.length <= 60 && PATTERN.test(value)
}
