const PATTERN = /^\d+\.\d+\.\d+$/g

export const name = 'appVersion'
export const hint = '3.12.0'

export function isValid(value) {
  return value.length <= 20 && PATTERN.test(value)
}
