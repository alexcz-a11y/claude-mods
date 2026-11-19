// Whole cents to a string with two decimals: 54500 -> "545.00".
export function money(cents) {
  const sign = cents < 0 ? '-' : ''
  const whole = Math.trunc(Math.abs(cents) / 100)
  const rest = String(Math.abs(cents) % 100).padStart(2, '0')
  return `${sign}${whole}.${rest}`
}

export function column(text, width, align = 'left') {
  const value = String(text)
  return align === 'right' ? value.padStart(width) : value.padEnd(width)
}
