export function requireInteger(value, what) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${what} must be a whole number above zero, got ${JSON.stringify(value)}`)
  }
  return value
}

export function requireText(value, what) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${what} is missing`)
  }
  return value
}
